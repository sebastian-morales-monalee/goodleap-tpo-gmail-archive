const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({
  console,
  safeCellValue_: (value) => value,
});
vm.runInContext(
  fs.readFileSync(path.join(root, 'OpenAIAnalysis.gs'), 'utf8'),
  context,
);
vm.runInContext(
  fs.readFileSync(path.join(root, 'ProjectIdSummary.gs'), 'utf8'),
  context,
);

test('explicit missing documentation is added without inferring Production', () => {
  const body = context.cleanOpenAIEmailBody_(
    'The project is within production tolerance. Required documentation is still missing.\n' +
    'On Tue, Sep 22, 2026 at 9:00 AM Someone wrote:\n' +
    'Production is outside tolerance.',
    30000,
  );
  const analysis = {primary_category: 'Other', categories: ['Other']};
  context.applyOpenAICategoryEvidenceRules_(analysis, body);
  assert.deepEqual(Array.from(analysis.categories), ['Documentation']);
  assert.equal(analysis.primary_category, 'Documentation');
  assert.doesNotMatch(body, /Production is outside tolerance/);
});

test('production keyword and kWh values alone do not add Production', () => {
  const analysis = {primary_category: 'Other', categories: ['Other']};
  context.applyOpenAICategoryEvidenceRules_(
    analysis,
    'Production is within tolerance at 11,600 kWh. The review is approved.',
  );
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
  const instructions = vm.runInContext('OPENAI_ANALYSIS_INSTRUCTIONS', context);
  assert.match(instructions, /Production: an explicit production-yield or benchmark discrepancy/);
  assert.match(instructions, /provisional estimate with compliance unverified/);
});

test('every named category has an operational rule and negative boundary', () => {
  const instructions = vm.runInContext('OPENAI_ANALYSIS_INSTRUCTIONS', context);
  for (const category of [
    'Production', 'Layout', 'Equipment', 'Shading / Site Conditions',
    'Structure', 'Documentation', 'Offset', 'Communication / Follow-up',
    'Sun Hours', 'Other',
  ]) {
    assert.ok(instructions.includes(`${category}:`), `${category} rubric missing`);
  }
  assert.match(instructions, /standard please-reply footer/);
  assert.match(instructions, /ordinary roof-plane placement or panel tilt\/layout alone/i);
  assert.match(instructions, /generic installation photos, panels merely being repositioned/);
  assert.match(instructions, /newest message body from scratch/);
});

test('split-line quoted replies cannot bring old issues into newest message', () => {
  const body = context.cleanOpenAIEmailBody_(
    'The revised layout must be finalized. Required installation photos are still missing.\n' +
    'On\n\n Fri, 21 Aug at 4:10 PM\n\n, Design Team <example@example.com> wrote:\n' +
    'Production is outside tolerance. The battery count is too low.\n',
    30000,
  );
  assert.match(body, /revised layout must be finalized/);
  assert.doesNotMatch(body, /Production is outside tolerance/);
  const analysis = {primary_category: 'Other', categories: ['Other']};
  context.applyOpenAICategoryEvidenceRules_(analysis, body);
  assert.deepEqual(Array.from(analysis.categories), ['Documentation']);
});

test('Sun Hours stays a topic and categories use only the latest message', () => {
  const analysis = {primary_category: 'Other', categories: ['Other']};
  context.applyOpenAICategoryEvidenceRules_(
    analysis, 'Please review the sunhours calculation.',
  );
  assert.deepEqual(Array.from(analysis.categories), ['Sun Hours']);

  const email = {
    latestGmailMessageId: 'new',
    latestCategories: 'Documentation',
    categoriesByMessageId: new Map([
      ['old', 'Production'],
      ['new', 'Documentation'],
    ]),
  };
  const latest = new Map([['26-41-000001', {
    messageId: 'new', timestamp: 2, sequence: 2,
  }]]);
  assert.equal(
    context.getProjectIdSummaryLatestCategories_(
      email, ['26-41-000001'], latest,
    ),
    'Documentation',
  );
});

test('new analysis rows carry category rules version', () => {
  const analysis = {
    primary_category: 'Production',
    categories: ['Production'],
  };
  const row = context.buildOpenAIAnalysisRow_(
    {messageId: 'message-1', applicationId: '26-41-000001'},
    analysis, 'test-model', 'response-1', 'Analyzed', '',
  );
  assert.equal(row.length, 26);
  assert.equal(row[25], '2026-09-25-all-categories-v2');
});

test('setup migration preserves existing columns in both supported layouts', () => {
  for (const layout of [
    'PRE_CATEGORY_RULES_OPENAI_ANALYSIS_HEADERS',
    'PRE_SUNHOURS_OPENAI_ANALYSIS_HEADERS',
  ]) {
    const oldHeaders = Array.from(vm.runInContext(layout, context));
    const headers = [...oldHeaders];
    const sheet = {
      getLastRow: () => 2,
      getLastColumn: () => headers.length,
      getRange: (_row, column) => ({
        getDisplayValues: () => [[...headers]],
        setValue(value) {
          headers[column - 1] = value;
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; },
      }),
      insertColumnAfter(column) { headers.splice(column, 0, ''); },
    };
    const spreadsheet = {getSheetByName: () => sheet};
    context.migrateOpenAIAnalysisSheetSchema_(spreadsheet);
    assert.deepEqual(headers.slice(0, oldHeaders.length), oldHeaders);
    assert.equal(headers[24], 'Sunhours Checked At');
    assert.equal(headers[25], 'Category Rules Version');
  }
});

test('historical reclassification updates only the latest email and is resumable', () => {
  const rows = [
    [],
    ['old', 'project-1', '26-41-000001', '', '', '', '', 'Production',
      'Production', '', '', '', '', '', '', '', '', '', '', '', '', '',
      'Analyzed', '', '', ''],
    ['new', 'project-1', '26-41-000001', '', '', '', '', 'Other',
      'Other', '', '', '', '', '', '', '', '', '', '', '', '', '',
      'Analyzed', '', '', ''],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getRange(row, column, count) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + count)
          .map((item) => item.slice(column - 1, column + 25)),
        setValues(values) { rows[row - 1] = values[0]; },
      };
    },
  };
  context.LockService = {getScriptLock: () => ({
    tryLock: () => true,
    releaseLock: () => {},
  })};
  context.SpreadsheetApp = {flush: () => {}};
  context.getOpenAIAnalysisSettings_ = () => ({batchSize: 10, model: 'test'});
  context.getOrCreateResources_ = () => ({spreadsheet: {}});
  context.getOrCreateOpenAIAnalysisSheet_ = () => sheet;
  context.loadAnalysisProjectIdMap_ = () => new Map([
    ['26-41-000001', 'project-1'],
  ]);
  context.loadLatestOpenAIProjectEmailCandidates_ = () => new Map([
    ['project-1', {candidate: {
      messageId: 'new', applicationId: '26-41-000001', body: 'Latest email',
    }}],
  ]);
  context.requestOpenAIEmailAnalysis_ = () => ({
    analysis: {primary_category: 'Documentation',
      categories: ['Documentation']},
    responseId: 'response-new',
  });

  const first = context.reclassifyLatestProjectEmailsWithOpenAI();
  assert.equal(first.reclassified, 1);
  assert.equal(rows[1][8], 'Production');
  assert.equal(rows[2][8], 'Documentation');
  assert.equal(rows[2][25], '2026-09-25-all-categories-v2');
  const second = context.reclassifyLatestProjectEmailsWithOpenAI();
  assert.equal(second.selectedMessages, 0);
});

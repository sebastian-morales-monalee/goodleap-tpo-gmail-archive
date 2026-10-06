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

test('within-tolerance production is removed while actual blockers remain', () => {
  const analysis = {
    primary_category: 'Production',
    categories: ['Production', 'Shading / Site Conditions', 'Documentation'],
    category_evidence: [{category: 'Shading / Site Conditions', quote: 'the project is blocked by shading'}],
  };
  context.applyOpenAICategoryEvidenceRules_(
    analysis,
    'Production is within tolerance, but the project is blocked by shading. ' +
      'Updated installation photos are still missing.',
  );
  assert.deepEqual(Array.from(analysis.categories), [
    'Shading / Site Conditions', 'Documentation',
  ]);
  assert.equal(analysis.primary_category, 'Shading / Site Conditions');
});

test('approved production with benchmark figures alone becomes Other', () => {
  const analysis = {primary_category: 'Production', categories: ['Production']};
  context.applyOpenAICategoryEvidenceRules_(
    analysis,
    'Production validation was approved. Proposed production is 10,354.662 ' +
      'kWh versus a 10,352 kWh benchmark at -0.03% tolerance.',
  );
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
  assert.equal(analysis.primary_category, 'Other');
});

test('production correction without numeric out-of-range tolerance is not Production', () => {
  for (const body of [
    'Production is outside tolerance. Revise the design.',
    'Production is within tolerance on one measure, but the pre-check failed ' +
      'for production on the corrected design.',
    'Production was within tolerance, but please recalculate production ' +
      'after the system change.',
  ]) {
    const analysis = {primary_category: 'Production', categories: ['Production']};
    context.applyOpenAICategoryEvidenceRules_(analysis, body);
    assert.deepEqual(Array.from(analysis.categories), ['Other'], body);
    assert.equal(analysis.primary_category, 'Other');
    assert.equal(analysis.requires_human_review, true);
  }
});

test('explicitly outside production tolerance adds Production when omitted', () => {
  const analysis = {
    primary_category: 'Other',
    categories: ['Other', 'Layout'],
    category_evidence: [{category: 'Layout', quote: 'the Origin module count does not match the submitted design'}],
    tolerance_percent: -28.22,
  };
  context.applyOpenAICategoryEvidenceRules_(
    analysis,
    'Production is outside tolerance, and the Origin module count does not ' +
      'match the submitted design.\nTolerance: -28.22%',
  );
  assert.deepEqual(Array.from(analysis.categories), ['Layout', 'Production']);
  assert.equal(analysis.primary_category, 'Layout');
});

test('a non-production tolerance issue does not add Production', () => {
  const analysis = {primary_category: 'Layout', categories: ['Layout'],
    category_evidence: [{category: 'Layout', quote: 'Roof tilt is outside tolerance'}]};
  context.applyOpenAICategoryEvidenceRules_(
    analysis, 'Roof tilt is outside tolerance. Revise the layout.',
  );
  assert.deepEqual(Array.from(analysis.categories), ['Layout']);
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
  assert.equal(row[25], '2026-10-06-scoped-rejection-v5');
});

const footer = '\nFor additional reference, please review the shade report available in Origin.\n' +
  'If any changes are made to the system design, upload a screenshot and notify us via email for re-review.\n' +
  'Please ensure the system offset does not exceed 110%, or 150% with a signed customer system offset acknowledgement form.';

test('33c9f239: explicit offset blocker remains, template categories do not', () => {
  const reason = 'Production - Offset exceeds the 110% threshold.';
  const step = 'Upload a signed Offset Acknowledgement Form to meet the 110% to 150% threshold.';
  const body = `Hello Team,\nRejection Reasons:\n${reason}\nSteps to Clear:\n${step}\n` +
    'Proposed Production: 7,853.22 kWh\nGoodLeap Benchmark Production: 7,967 kWh\nTolerance: 1.45%' + footer;
  const analysis = {primary_category: 'Production',
    categories: ['Production', 'Offset', 'Documentation', 'Communication / Follow-up'],
    category_evidence: [
      {category: 'Production', quote: reason}, {category: 'Offset', quote: reason},
      {category: 'Documentation', quote: step},
      {category: 'Communication / Follow-up', quote: 'notify us via email for re-review'},
    ]};
  context.applyOpenAICategoryEvidenceRules_(analysis, body);
  assert.deepEqual(Array.from(analysis.categories), ['Offset', 'Documentation']);
  assert.equal(analysis.primary_category, 'Offset');
});

test('ad680382: footer-only Offset, Documentation and Follow-up are removed', () => {
  const reasons = ['Production - Design out of tolerance by -28.22%',
    'Due to shading issues the design does not meet our minimum 1,050 kW sunhours.',
    'Trees surrounding the home are not all accounted for in the submitted design.'];
  const body = 'Hello Team,\nRejection Reasons:\n' + reasons.join('\n') +
    '\nSteps to Clear:\nUpdate your shading to reflect the onsite conditions.\n' +
    'Proposed Production: 8,494.905 kWh\nGoodLeap Benchmark Production: 6,098 kWh\nTolerance: -28.22%' + footer;
  const analysis = {primary_category: 'Production',
    categories: ['Production', 'Shading / Site Conditions', 'Sun Hours', 'Offset', 'Documentation', 'Communication / Follow-up'],
    category_evidence: [
      {category: 'Production', quote: reasons[0]},
      {category: 'Shading / Site Conditions', quote: reasons[2]},
      {category: 'Sun Hours', quote: reasons[1]},
      {category: 'Offset', quote: 'Please ensure the system offset does not exceed 110%'},
      {category: 'Documentation', quote: 'upload a screenshot'},
      {category: 'Communication / Follow-up', quote: 'notify us via email for re-review'},
    ]};
  context.applyOpenAICategoryEvidenceRules_(analysis, body);
  assert.deepEqual(Array.from(analysis.categories), ['Production', 'Shading / Site Conditions', 'Sun Hours']);
});

test('Production requires a numeric tolerance strictly outside inclusive -5 and +15', () => {
  for (const [tolerance, expected] of [[-5, false], [15, false], [0, false],
    [-5.01, true], [15.01, true], [null, false], ['', false]]) {
    const reason = 'Production is outside tolerance. Revise the design.';
    const analysis = {primary_category: 'Production', categories: ['Production'],
      tolerance_percent: tolerance, category_evidence: [{category: 'Production', quote: reason}]};
    context.applyOpenAICategoryEvidenceRules_(analysis, `Hello Team,\n${reason}\nProposed Production: 123 kWh\n` +
      (typeof tolerance === 'number' ? `Tolerance: ${tolerance}%` : ''));
    assert.equal(analysis.categories.includes('Production'), expected, String(tolerance));
  }
});

test('body tolerance overrides an inconsistent AI value and zero is preserved', () => {
  const analysis = {primary_category: 'Production', categories: ['Production'], tolerance_percent: 28};
  context.applyOpenAICategoryEvidenceRules_(analysis,
    'Hello Team,\nProduction is outside tolerance.\nProposed Production: 123\nTolerance: 0%');
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
});

test('AI-invented tolerance cannot qualify Production; same-email archive fallback can', () => {
  const body = 'Hello Team,\nProduction is outside tolerance.';
  const analysis = {primary_category: 'Production', categories: ['Production'], tolerance_percent: -25};
  context.applyOpenAICategoryEvidenceRules_(analysis, body);
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
  const fallback = {primary_category: 'Production', categories: ['Production']};
  context.applyOpenAICategoryEvidenceRules_(fallback, body, -25);
  assert.deepEqual(Array.from(fallback.categories), ['Production']);
});

test('all named categories require an exact quote inside the scoped block', () => {
  const analysis = {primary_category: 'Equipment', categories: ['Equipment', 'Structure', 'Layout'],
    category_evidence: [
      {category: 'Equipment', quote: 'The inverter count is incorrect.'},
      {category: 'Structure', quote: 'The roof is not eligible.'},
      {category: 'Layout', quote: 'The layout must change.'},
    ]};
  context.applyOpenAICategoryEvidenceRules_(analysis,
    'Hello Team,\nThe inverter count is incorrect.\nProposed Production: 123\n' +
    'The roof is not eligible.\nThe layout must change.');
  assert.deepEqual(Array.from(analysis.categories), ['Equipment']);
});

test('generic uploads and coordination do not qualify inside the block either', () => {
  const text = 'If any changes are made, upload a revised screenshot and please re-review the case.';
  const analysis = {primary_category: 'Documentation', categories: ['Documentation', 'Communication / Follow-up'],
    category_evidence: [{category: 'Documentation', quote: text},
      {category: 'Communication / Follow-up', quote: text}]};
  context.applyOpenAICategoryEvidenceRules_(analysis, `Hello Team,\n${text}\nProposed Production: 123`);
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
});

test('resolved or generic Offset and Sun Hours mentions inside the block are excluded', () => {
  const text = 'Please ensure offset stays below 110%. The design meets our minimum sun hours.';
  const analysis = {primary_category: 'Offset', categories: ['Offset', 'Sun Hours'],
    category_evidence: [{category: 'Offset', quote: text}, {category: 'Sun Hours', quote: text}]};
  context.applyOpenAICategoryEvidenceRules_(analysis, `Hello Team,\n${text}\nProposed Production: 123`);
  assert.deepEqual(Array.from(analysis.categories), ['Other']);
});

test('submitted documentation is not a blocker but a missing form is', () => {
  assert.equal(context.hasExplicitOpenAIDocumentationNeed_('Required documents were submitted.'), false);
  assert.equal(context.hasExplicitOpenAIDocumentationNeed_('The signed acknowledgement form is missing.'), true);
});

test('scoping handles whitespace, absent greeting and missing production marker', () => {
  assert.equal(context.extractOpenAICategoryBlock_(
    'Banner\nHello\nTeam,\nMissing documents.\nProposed\nProduction: 123'),
  'Hello\nTeam,\nMissing documents.');
  assert.equal(context.extractOpenAICategoryBlock_(
    'Required photos are missing.\nFor additional reference, offset reminder'),
  'Required photos are missing.');
  assert.equal(context.extractOpenAICategoryBlock_('Hello Team,\nPlease ensure the system offset stays below 110%.'),
    'Hello Team,');
});

test('a proposed production mention in a rejection reason is not the metrics boundary', () => {
  const block = context.extractOpenAICategoryBlock_(
    'Hello Team,\nThe proposed production is inaccurate and must be corrected.\n' +
    'Proposed Production: 123 kWh\nTolerance: -10%');
  assert.match(block, /must be corrected/);
  assert.doesNotMatch(block, /123 kWh/);
});

test('input retains full metrics and schema requires internal quote evidence', () => {
  const body = 'Hello Team,\nRequired photos are missing.\nProposed Production: 123\nTolerance: -8%' + footer;
  const input = context.buildOpenAIEmailInput_({applicationId: 'test'}, body);
  assert.ok(input.includes('Tolerance: -8%'));
  const block = input.split('Category evidence block (the only permitted source of category quotes):')[1];
  assert.doesNotMatch(block, /Proposed Production|For additional reference/);
  const schema = context.buildOpenAIAnalysisJsonSchema_();
  assert.ok(schema.required.includes('category_evidence'));
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
  let published = 0;
  context.refreshProjectIdSummarySafely_ = (_spreadsheet, options) => {
    assert.equal(options.refreshMapData, false);
    published += 1;
    return {updated: true};
  };
  context.refreshAIAnalysisDashboardSafely_ = () => ({updated: true});

  const first = context.reclassifyLatestProjectEmailsWithOpenAI();
  assert.equal(first.reclassified, 1);
  assert.equal(published, 1);
  assert.equal(first.projectIdSummary.updated, true);
  assert.equal(first.dashboard.updated, true);
  assert.equal(rows[1][8], 'Production');
  assert.equal(rows[2][8], 'Documentation');
  assert.equal(rows[2][25], '2026-10-06-scoped-rejection-v5');
  const second = context.reclassifyLatestProjectEmailsWithOpenAI();
  assert.equal(second.selectedMessages, 0);
});

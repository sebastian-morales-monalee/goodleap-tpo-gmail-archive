const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
function setup() { const ctx = vm.createContext({console, Date}); vm.runInContext(source, ctx); return ctx; }
const project = '8841a770-7a58-46e9-8455-f3d607bbd710';
function spreadsheet(rows) {return {getSheetByName: () => ({
  getName: () => 'PDF Analysis', getLastRow: () => rows.length,
  getLastColumn: () => rows[0].length, getRange: () => ({getValues: () => rows}),
})};}
test('latest PDF is chosen by Source Received At, independently of analysis time and row order', () => {
  const ctx = setup();
  const rows = [['Source PDF URL', 'Analyzed At', 'Project ID', 'Source Received At'],
    ['https://drive.google.com/new', new Date('2026-09-20'), project.toUpperCase(), new Date('2026-09-19')],
    ['https://drive.google.com/old', new Date('2026-10-01'), project, new Date('2026-09-18')],
    ['https://drive.google.com/undated', new Date('2026-10-02'), project, ''],
  ];
  const latest = ctx.loadProjectIdSummaryLatestShadeReports_(spreadsheet(rows));
  assert.equal(latest.get(project).url, 'https://drive.google.com/new');
  assert.equal(latest.get('missing'), undefined);
  rows.push(['https://drive.google.com/tie', '', project, new Date('2026-09-19')]);
  assert.equal(ctx.loadProjectIdSummaryLatestShadeReports_(spreadsheet(rows)).get(project).url, 'https://drive.google.com/tie');
  rows.push(['', '', project, new Date('2026-09-20')]);
  assert.equal(ctx.loadProjectIdSummaryLatestShadeReports_(spreadsheet(rows)).get(project).url, '');
});
test('missing or empty PDF source is safe; an incompatible source is explicit', () => {
  const ctx = setup();
  assert.equal(ctx.loadProjectIdSummaryLatestShadeReports_({getSheetByName: () => null}).size, 0);
  assert.equal(ctx.loadProjectIdSummaryLatestShadeReports_(spreadsheet([['Project ID']])).size, 0);
  assert.throws(() => ctx.loadProjectIdSummaryLatestShadeReports_(spreadsheet([['Project ID'], [project]])), /Source Received At/);
});
test('new header and linked fields maintain full-row schema and dynamic formulas', () => {
  const ctx = setup();
  const headers = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', ctx));
  assert.deepEqual(headers.slice(0, 5), ['Project ID', 'Application ID', 'Project URL', 'Aurora Shade Report URL', 'Address']);
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX', ctx), headers.indexOf('Gmail Message ID'));
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX', ctx), headers.indexOf('Latest AI Email Received At'));
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_POSTHOG_START_INDEX', ctx), headers.indexOf('Engine Version'));
  const formulas = ctx.projectIdSummaryConditionalFormulas_(2, 51);
  assert.match(formulas[0], /R2\/J2/);
  assert.match(formulas[1], /TRIM\(F2\)/);
  assert.match(formulas[2], /T2<=110/);
});

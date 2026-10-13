const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'AIAnalysisDashboard.gs'), 'utf8');
test('weekly email title migration is targeted, idempotent and preserves existing charts', () => {
  const old = 'Weekly Production vs Other Categories';
  const expected = 'Weekly Categorized Emails Received: Production vs Other Issues';
  const cell = {value: old, setValue(value) {this.value = value;}};
  const chart = title => ({title, getOptions() {return {get: () => this.title};},
    modify() {return {setOption: (_, value) => ({build: () => {this.title = value; return this;}})};}});
  const target = chart(old), other = chart('Weekly Production Projects');
  let updated = 0;
  const sheet = {createTextFinder: value => ({matchEntireCell: () => ({findAll: () => cell.value === value ? [cell] : []})}),
    getCharts: () => [target, other], updateChart: () => updated++};
  const ctx = vm.createContext({console, SpreadsheetApp: {flush() {}}});
  vm.runInContext(source, ctx);
  const book = {getSheetByName: name => name === 'AI Dashboard' ? sheet : null};
  const first = ctx.renameWeeklyReceivedEmailsChartForSpreadsheet_(book);
  assert.equal(first.renamedCells, 1);
  assert.equal(first.renamedCharts, 1);
  assert.equal(cell.value, expected);
  assert.equal(target.title, expected);
  assert.equal(other.title, 'Weekly Production Projects');
  ctx.renameWeeklyReceivedEmailsChartForSpreadsheet_(book);
  assert.equal(updated, 1);
  assert.match(source, /setOption\('title', AI_ANALYSIS_DASHBOARD_CONFIG.WEEKLY_CHART_MATRIX_TITLE\)/);
});

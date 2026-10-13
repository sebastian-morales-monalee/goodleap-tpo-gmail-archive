const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'AIAnalysisDashboard.gs'), 'utf8');
test('created/rejected title changes both tables and chart, preserving updated-project chart', () => {
  const cells = ['Weekly Production Projects', 'Weekly Production Projects Chart Source']
    .map(value => ({value, setValue(next) {this.value = next;}}));
  const chart = title => ({title, getOptions() {return {get: () => this.title};},
    modify() {return {setOption: (_, value) => ({build: () => {this.title = value; return this;}})};}});
  const charts = [chart('Weekly Production Projects'), chart('Weekly Production Updated Projects')];
  let updates = 0;
  const sheet = {createTextFinder: value => ({matchEntireCell: () => ({findAll: () => cells.filter(c => c.value === value)})}),
    getCharts: () => charts, updateChart: () => updates++};
  const ctx = vm.createContext({console, SpreadsheetApp: {flush() {}}});
  vm.runInContext(source, ctx);
  const book = {getSheetByName: name => name === 'AI Weekly Summary' ? sheet : null};
  const result = ctx.renameWeeklyCreatedVsRejectedProjectsForSpreadsheet_(book);
  assert.equal(result.renamedCells, 2);
  assert.equal(result.renamedCharts, 1);
  assert.equal(cells[0].value, 'Weekly Created vs Rejected Projects');
  assert.equal(cells[1].value, 'Weekly Created vs Rejected Projects Chart Source');
  assert.equal(charts[1].title, 'Weekly Production Updated Projects');
  ctx.renameWeeklyCreatedVsRejectedProjectsForSpreadsheet_(book);
  assert.equal(updates, 1);
});

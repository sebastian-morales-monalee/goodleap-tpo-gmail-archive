const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const context = vm.createContext({console});
const source = fs.readFileSync(path.join(__dirname, '..', 'AIAnalysisDashboard.gs'), 'utf8');
vm.runInContext(source, context);
const headers = ['Project ID', 'kWh/kW >= MIN', 'Offset <= 110%', '110 % < offset ≤ 150 %'];

test('chart order and English labels match the four requested groups', () => {
  const rows = context.buildGoodLeapConditionsChartRows_(headers, 'Project ID Summary', 1000);
  assert.deepEqual(Array.from(rows, (row) => row[0]), [
    'Total Projects', 'kWh/kW ≥ MIN AND Offset ≤ 110%',
    'Projects with Missing Data', 'kWh/kW ≥ MIN AND 110% < Offset ≤ 150%',
  ]);
  assert.equal(rows[0][1], '=COUNTIFS(\'Project ID Summary\'!$A$2:$A$1000,"<>")');
  assert.match(rows[1][1], /\$B\$2:\$B\$1000,TRUE.*\$C\$2:\$C\$1000,TRUE/);
  assert.match(rows[3][1], /\$B\$2:\$B\$1000,TRUE.*\$D\$2:\$D\$1000,TRUE/);
});

test('missing-data formula checks each boolean once per populated project, not FALSE', () => {
  const formula = context.buildGoodLeapConditionsChartRows_(headers, 'Project ID Summary', 118)[2][1];
  assert.equal(formula, '=SUMPRODUCT((\'Project ID Summary\'!$A$2:$A$118<>"")*(((\'Project ID Summary\'!$B$2:$B$118="")+(\'Project ID Summary\'!$C$2:$C$118="")+(\'Project ID Summary\'!$D$2:$D$118=""))>0))');
  const samples = [['p1',true,true,false], ['p2',true,false,true],
    ['p3',false,false,false], ['p4','','',''], ['p5',true,'',false], ['',true,true,true]];
  assert.deepEqual([
    samples.filter(r => r[0] !== '').length,
    samples.filter(r => r[0] !== '' && r[1] === true && r[2] === true).length,
    samples.filter(r => r[0] !== '' && r.slice(1).some(v => v === '')).length,
    samples.filter(r => r[0] !== '' && r[1] === true && r[3] === true).length,
  ], [5,1,2,1]);
});

test('header-based ranges survive reordering and missing headers fail explicitly', () => {
  const rows = context.buildGoodLeapConditionsChartRows_([...headers].reverse(), "Project's Summary", 1);
  assert.match(rows[0][1], /'Project''s Summary'!\$D\$2:\$D\$2/);
  assert.throws(() => context.buildGoodLeapConditionsChartRows_(headers.slice(0,3), 'Summary', 20), /Missing conditions chart header/);
  assert.match(source, /doesAIAnalysisDashboardDataMatch_\(sheet, summary, visibleWeeks\)\s*\) \{\s*refreshGoodLeapConditionsChart_/);
});

test('refresh preserves existing charts and setup never leaves duplicates', () => {
  let charts = [{getOptions: () => ({get: () => 'Existing Chart'})}];
  let builds = 0;
  const calls = [];
  const values = [5,1,2,1];
  const range = {setValues(v) { calls.push(v); return this; }, setFormulas(v) {calls.push(v); return this;},
    setFontFamily() {return this;}, setFontSize() {return this;}, setVerticalAlignment() {return this;},
    setBackground() {return this;}, setFontColor() {return this;}, setFontWeight() {return this;},
    setNumberFormat() {return this;}, setValue() {return this;}, getValues: () => values.map(v => [v])};
  const sheet = {getName: () => 'AI Dashboard', getRange: () => range,
    setColumnWidth() {}, getCharts: () => charts, removeChart(c) {charts = charts.filter(v => v !== c);},
    insertChart(c) {charts.push(c);}, newChart() {
      builds++;
      const options = {};
      const builder = {asColumnChart() {return this;}, addRange(r) {assert.equal(r, range);return this;},
        setNumHeaders() {return this;}, setPosition() {return this;},
        setOption(k,v) {options[k]=v;return this;}, build() {return {getOptions: () => ({get: k => options[k]})};}};
      return builder;
    }};
  const spreadsheet = {getSheetByName: () => ({getRange: () => ({getValues: () => [headers]}),
    getLastColumn: () => 4, getMaxRows: () => 1000, getName: () => 'Project ID Summary'})};
  context.SpreadsheetApp = {flush() {}};
  context.ensureAIAnalysisSheetCapacity_ = () => {};
  context.refreshGoodLeapConditionsChart_(spreadsheet, sheet);
  context.refreshGoodLeapConditionsChart_(spreadsheet, sheet);
  assert.equal(builds, 1);
  assert.equal(charts.length, 2);
  const stats = context.refreshGoodLeapConditionsChart_(spreadsheet, sheet, true);
  assert.equal(builds, 2);
  assert.equal(charts.length, 2);
  assert.deepEqual(Array.from(stats.counts), values);
  assert.ok(calls.some(v => v[0][0].startsWith('=COUNTIFS')));
});

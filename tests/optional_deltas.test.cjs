const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
test('panel delta uses the summary active count and the recalculated Aurora count', () => {
  const context = vm.createContext({console, Date});
  vm.runInContext(source, context);
  const projectId = '763391bd-48fd-415b-b580-34bc7f30343f';
  const deltaHeaders = vm.runInContext('PROJECT_ID_SUMMARY_COMPARISON_DELTA_HEADERS', context);
  const headers = ['Project ID', 'Match Type', 'Aurora Panel Count', 'Artemis Panel Count', ...deltaHeaders];
  const values = [
    headers,
    [projectId, 'Recalculated Weighted Average', 22, 27, 5, -2, 1],
    [projectId, 'Forced Nearest Match', 10, 15, 5, -3, 1],
  ];
  const sheet = {
    getName: () => 'Shade Reports Comparison',
    getLastRow: () => values.length,
    getLastColumn: () => headers.length,
    getRange: () => ({getValues: () => values}),
  };
  const load = () => context.loadProjectIdSummaryComparisonDeltas_({getSheetByName: () => sheet});
  const comparison = load().get(projectId);
  const build = context.buildProjectIdSummaryDeltaValues_;
  assert.deepEqual(Array.from(build(comparison, 22).slice(0, 6)), [0, -2, 2, 1, 1, 3]);
  assert.equal(build(comparison, 20)[0], -2);
  assert.equal(build(comparison, 0)[0], -22);
  assert.equal(build(comparison, '')[0], '');
  assert.equal(build(undefined, 22)[0], '');
  values[1][2] = '';
  assert.equal(build(load().get(projectId), 22)[0], '');
});

test('restoration inserts the 21 delta columns before metadata only once', () => {
  const context = vm.createContext({console, Date});
  vm.runInContext(source, context);
  const full = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', context));
  const deltas = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_ACTIVE_DELTA_HEADERS', context));
  assert.equal(deltas.length, 21);
  assert.equal(full.indexOf('Engine Version'), 70);
  const headers = full.filter(header => !deltas.includes(header));
  let inserts = 0;
  const sheet = {
    insertColumnsBefore(start, width) { inserts++; headers.splice(start - 1, 0, ...Array(width).fill('')); },
    getRange(row, start, height, width) {
      assert.equal(row, 1);
      assert.equal(height, 1);
      return {setValues([values]) { headers.splice(start - 1, width, ...values); }};
    },
  };
  context.insertProjectIdSummaryDeltaColumns_(sheet, headers);
  assert.deepEqual(headers, full);
  context.insertProjectIdSummaryDeltaColumns_(sheet, headers);
  assert.throws(() => context.insertProjectIdSummaryDeltaColumns_(sheet, ['Unknown']), /Unexpected/);
  assert.equal(inserts, 1);
});

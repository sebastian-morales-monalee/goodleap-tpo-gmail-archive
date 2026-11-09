const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
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

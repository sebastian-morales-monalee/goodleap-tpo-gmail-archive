const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
test('optional deltas are disabled, metadata shifts to BA and restoration retains old schema', () => {
  const context = vm.createContext({console, Date});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext("PROJECT_ID_SUMMARY_HEADERS.indexOf('Engine Version')", context), 52);
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_POSTHOG_START_INDEX', context), 52);
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_ACTIVE_DELTA_HEADERS.length', context), 0);
  assert.equal(context.loadProjectIdSummaryComparisonDeltas_({getSheetByName(){throw Error('should not read');}}).size, 0);
  const restored = vm.createContext({console, Date});
  vm.runInContext(source.replace('PROJECT_ID_SUMMARY_ENABLE_COMPARISON_DELTAS = false', 'PROJECT_ID_SUMMARY_ENABLE_COMPARISON_DELTAS = true'), restored);
  assert.equal(vm.runInContext("PROJECT_ID_SUMMARY_HEADERS.indexOf('Engine Version')", restored), 73);
  assert.equal(vm.runInContext('PROJECT_ID_SUMMARY_POSTHOG_START_INDEX', restored), 73);
});

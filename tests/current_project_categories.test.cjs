const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'AIAnalysisDashboard.gs'), 'utf8');
const ctx = vm.createContext({console});
vm.runInContext(source, ctx);
const read = values => JSON.parse(JSON.stringify(ctx.buildCurrentProjectCategoryCounts_(values)));

test('current counts split all categories and deduplicate within project including duplicate rows', () => {
  const result = read([['Categories', 'Project ID'],
    ['Production; Layout; production; ;', 'a'],
    ['Offset;Layout', 'a'], ['Layout', 'b'], ['', 'c'], ['Equipment', '']]);
  assert.equal(result.totalProjects, 3);
  assert.equal(result.categorizedProjects, 2);
  assert.equal(result.categoryAssignments, 4);
  assert.deepEqual(result.rows.map(r => [r.category, r.count, r.percentage]),
    [['Layout', 2, 1], ['Offset', 1, 0.5], ['Production', 1, 0.5]]);
});
test('blank source retains zero totals; missing headers fail explicitly', () => {
  assert.equal(read([['Project ID', 'Categories']]).rows.length, 0);
  assert.throws(() => read([['Project ID', 'Wrong']]), /requires/);
});
test('current refresh uses header-driven summary; historical weekly counts are unchanged', () => {
  assert.match(source, /const currentCategories = loadCurrentProjectCategoryCounts_/);
  assert.match(source, /categoryAssignments/);
  const hook = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
  assert.match(hook, /result.currentProjectCategories = refreshCurrentProjectCategoriesForSpreadsheet_\(spreadsheet\)/);
  assert.match(source, /incrementAIAnalysisCategoryCount_\(allTimeCounts, category\)/);
});
test('existing chart refresh always republishes current labels before idempotent return', () => {
  const body = source.slice(source.indexOf('function refreshCurrentProjectCategoryChart_'),
    source.indexOf('/** Lightweight publication hook'));
  assert.ok(body.indexOf("setValue('Projects with Categories')") < body.indexOf('return summary;'));
  assert.ok(body.indexOf('setValue(summary.categorizedProjects)') < body.indexOf('return summary;'));
});

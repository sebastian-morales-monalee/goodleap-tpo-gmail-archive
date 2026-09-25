const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({console});
for (const file of [
  'OpenAIAnalysis.gs',
  'ProjectIdSummary.gs',
  'CategoryExplorer.gs',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
}

const headers = Array.from(
  vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', context),
);

test('the explorer uses all configured categories, including Sun Hours', () => {
  const categories = Array.from(
    vm.runInContext('OPENAI_ANALYSIS_CATEGORIES', context),
  );
  assert.ok(categories.includes('Production'));
  assert.ok(categories.includes('Communication / Follow-up'));
  assert.ok(categories.includes('Sun Hours'));
  assert.equal(categories.length, 10);
});

test('the view reads the seven intended summary columns and a bounded range', () => {
  const formula = context.buildCategoryExplorerFilterFormula_(
    headers,
    'Project ID Summary',
    5001,
  );
  for (const column of ['A', 'B', 'C', 'AB', 'AD', 'F', 'U']) {
    assert.ok(
      formula.includes(`'Project ID Summary'!$${column}$2:$${column}$5001`),
      column,
    );
  }
  assert.match(formula, /^=IF\(\$B\$3="","",IFNA\(FILTER\(/);
  assert.match(formula, /REGEXMATCH\('Project ID Summary'!\$AB\$2:\$AB\$5001/);
  assert.match(formula, /\(\^\|;\\s\*\).*\\s\*;\|\$\)/);
});

test('setup accepts the existing six-column view and the new AI Summary view', () => {
  const required = Array.from(vm.runInContext(
    'CATEGORY_EXPLORER_CONFIG.RESULT_HEADERS', context,
  ));
  assert.equal(required.at(-1), 'AI Summary');
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    ['', '', '', '', '', '', ''], required,
  ), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...required.slice(0, -1), ''], required,
  ), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(required, required), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...required.slice(0, -1), 'Other'], required,
  ), false);
});

test('the category boundary excludes substrings and supports multiword names', () => {
  const hasCategory = (value, category) =>
    new RegExp(`(^|;\\s*)${category}(\\s*;|$)`).test(value);
  assert.equal(hasCategory('Production; Documentation', 'Production'), true);
  assert.equal(hasCategory('Production; Documentation', 'Documentation'), true);
  assert.equal(hasCategory('Other Categories without Production', 'Other'), false);
  assert.equal(hasCategory('Shading / Site Conditions; Sun Hours', 'Sun Hours'), true);
  assert.equal(hasCategory('Communication / Follow-up', 'Communication / Follow-up'), true);
  assert.equal(hasCategory('Production', 'Production'), true);
  assert.equal(hasCategory('', 'Production'), false);
});

test('an incompatible source schema stops setup before writing the view', () => {
  assert.throws(
    () => context.buildCategoryExplorerFilterFormula_(
      ['Project ID', 'Categories'],
      'Project ID Summary',
      5001,
    ),
    /Missing source column: Application ID/,
  );
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({console});
for (const file of [
  'Code.gs',
  'OpenAIAnalysis.gs',
  'ProjectIdSummary.gs',
  'CategoryExplorer.gs',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
}

const headers = Array.from(
  vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', context),
);
const emailHeaders = Array.from(vm.runInContext('EMAIL_HEADERS', context));

test('the explorer uses all configured categories, including Sun Hours', () => {
  const categories = Array.from(
    vm.runInContext('OPENAI_ANALYSIS_CATEGORIES', context),
  );
  assert.ok(categories.includes('Production'));
  assert.ok(categories.includes('Communication / Follow-up'));
  assert.ok(categories.includes('Sun Hours'));
  assert.equal(categories.length, 10);
});

test('the view reads the thirteen intended columns and joins the group URL by message ID', () => {
  const formula = context.buildCategoryExplorerFilterFormula_(
    headers,
    'Project ID Summary',
    5001,
    emailHeaders,
  );
  for (const column of ['A', 'B', 'C', 'AB', 'AD', 'F', 'U', 'R']) {
    assert.ok(
      formula.includes(`'Project ID Summary'!$${column}$2:$${column}$5001`),
      column,
    );
  }
  assert.match(formula, /^=IF\(\$B\$3="","",IFNA\(FILTER\(/);
  assert.match(formula, /REGEXMATCH\('Project ID Summary'!\$AB\$2:\$AB\$5001/);
  assert.match(formula, /\(\^\|;\\s\*\).*\\s\*;\|\$\)/);
  assert.ok(formula.includes("VLOOKUP('Project ID Summary'!$R$2:$R$5001,{'Emails'!$Q$2:$Q,'Emails'!$T$2:$T},2,FALSE)"));
  assert.ok(formula.includes('ARRAYFORMULA(IF('));
});

test('setup accepts both previous views and the thirteen-column view', () => {
  const required = Array.from(vm.runInContext(
    'CATEGORY_EXPLORER_CONFIG.RESULT_HEADERS', context,
  ));
  assert.deepEqual(required, [
    'AI Summary', 'Categories', 'Email Count', 'Last Email Received At',
    'Google Group URL', 'Installer', 'State', 'Region', 'Status',
    'Project URL', 'Project ID', 'Application ID', 'Gmail Message ID',
  ]);
  const legacySix = [
    'Project ID', 'Application ID', 'Project URL',
    'Categories', 'Status', 'Region',
  ];
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    Array(13).fill(''), required,
  ), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...legacySix, ...Array(7).fill('')], required,
  ), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...legacySix, 'AI Summary', ...Array(6).fill('')], required,
  ), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(required, required), true);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...legacySix, 'Other', ...Array(6).fill('')], required,
  ), false);
  assert.equal(context.categoryExplorerHasCompatibleHeaders_(
    [...legacySix, 'AI Summary', 'Unexpected', ...Array(5).fill('')], required,
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
      emailHeaders,
    ),
    /Missing source column: Gmail Message ID/,
  );
});

test('the lookup rejects missing Emails headers', () => {
  assert.throws(
    () => context.buildCategoryExplorerFilterFormula_(
      headers, 'Project ID Summary', 5001, ['Gmail Message ID'],
    ),
    /Emails must include Gmail Message ID and Google Group URL/,
  );
});

test('project count follows the Project ID column even when AI Summary is blank', () => {
  const script = fs.readFileSync(path.join(root, 'CategoryExplorer.gs'), 'utf8');
  assert.match(script, /COUNTIF\(\$K\$8:\$K,"\?\*"\)/);
  assert.match(script, /getRange\('D8:D' \+ lastResultRow\)[\s\S]*?setNumberFormat\('yyyy-mm-dd hh:mm:ss'\)/);
});

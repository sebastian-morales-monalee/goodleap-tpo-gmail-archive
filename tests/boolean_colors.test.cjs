const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
const context = vm.createContext({console});
vm.runInContext(source, context);

test('boolean colors are live, blank-safe, idempotent and preserve unrelated rules', () => {
  const unrelated = {getBooleanCondition: () => null};
  let rules = [unrelated];
  const styles = [];
  const range = {getA1Notation: () => 'Y2:AA1000', getRow: () => 2,
    getColumn: () => 25, getNumColumns: () => 3,
    setBackground(v) {styles.push(v); return this;}, setFontColor(v) {return this;}};
  const sheet = {getMaxRows: () => 1000, getRange(row,col,count,width) {
    assert.deepEqual([row,col,count,width], [2,25,999,3]); return range;
  }, getConditionalFormatRules: () => rules, setConditionalFormatRules(v) {rules = v;}};
  context.SpreadsheetApp = {BooleanCriteria: {CUSTOM_FORMULA: 'CUSTOM_FORMULA'},
    newConditionalFormatRule() {
      let formula, color, ranges;
      return {whenFormulaSatisfied(v) {formula=v; return this;},
        setBackground(v) {color=v; return this;}, setFontColor() {return this;},
        setRanges(v) {ranges=v; return this;}, build() {
          return {color, formula, getRanges: () => ranges, getBooleanCondition: () => ({
            getCriteriaType: () => 'CUSTOM_FORMULA', getCriteriaValues: () => [formula],
          })};
        }};
    }};
  context.applyProjectIdSummaryBooleanColors_(sheet);
  context.applyProjectIdSummaryBooleanColors_(sheet);
  assert.equal(rules.length, 3);
  assert.equal(rules[0], unrelated);
  assert.equal(rules[1].formula, '=AND(ISLOGICAL(Y2),Y2=TRUE)');
  assert.equal(rules[2].formula, '=AND(ISLOGICAL(Y2),Y2=FALSE)');
  assert.equal(rules[1].color, '#b7e1cd');
  assert.equal(rules[2].color, '#f4cccc');
  assert.ok(styles.every(v => v === '#ffffff'));
  assert.match(source, /setFormulas\(formulas\);\s*applyProjectIdSummaryBooleanColors_\(sheet\)/);
});

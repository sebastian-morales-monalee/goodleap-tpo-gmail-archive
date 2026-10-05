const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
function setup() { const ctx = vm.createContext({console, Date}); vm.runInContext(source, ctx); return ctx; }
test('dates trail Design Updated At and built rows preserve every field', () => {
  const ctx = setup();
  const headers = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', ctx));
  const before = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_ROW_BUILD_HEADERS', ctx));
  assert.deepEqual(headers.slice(-5), ['Design Updated At', 'Latest AI Email Received At', 'First Email Received At', 'Last Email Received At', 'Snapshot Date']);
  assert.equal(headers.length, before.length);
  const values = before.map((header, i) => header.endsWith('At') || header === 'Snapshot Date' ? new Date(2026, 9, i + 1) : header);
  const ordered = ctx.orderProjectIdSummaryBuiltRow_(values);
  headers.forEach((header, i) => assert.equal(ordered[i], values[before.indexOf(header)]));
  assert.equal(headers.indexOf('Latest AI Email Received At'), 55);
});
test('physical migration preserves columns and is idempotent', () => {
  const ctx = setup();
  const before = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_ROW_BUILD_HEADERS', ctx));
  const expected = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS', ctx));
  const physical = before.slice(); const moves = [];
  const sheet = {getMaxRows: () => 1000, getRange: (r,c,n,w) => ({r,c,n,w}), moveColumns(range, destination) {
    assert.equal(range.n, 1000); assert.equal(range.w, 1);
    physical.splice(destination - 1, 0, physical.splice(range.c - 1, 1)[0]); moves.push(range.c);
  }};
  ctx.moveProjectIdSummaryDateColumns_(sheet, before);
  assert.deepEqual(physical, expected); assert.deepEqual(before, expected);
  const count = moves.length; ctx.moveProjectIdSummaryDateColumns_(sheet, before);
  assert.equal(moves.length, count);
});
test('all four moved dates receive green headers and date styles after other styles', () => {
  assert.match(source, /PROJECT_ID_SUMMARY_TRAILING_DATE_HEADERS\.forEach\(header => \{[\s\S]*?PROJECT_METADATA_HEADER_BACKGROUND/);
  assert.match(source, /PROJECT_ID_SUMMARY_TRAILING_DATE_HEADERS\.forEach\(header => \{[\s\S]*?PROJECT_METADATA_DATA_BACKGROUND[\s\S]*?DATE_FORMAT/);
  assert.match(source, /getRange\(startRow, latestAiStartColumn, rowCount, 2\)[\s\S]*?setNumberFormat\('0\.###'\)/);
});

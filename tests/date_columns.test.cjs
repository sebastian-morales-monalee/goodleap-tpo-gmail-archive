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
  assert.deepEqual(headers.slice(-7), ['Design Updated At', 'Latest AI Email Received At', 'First Email Received At', 'Last Email Received At', 'Days Between First and Last Email', 'Email Count', 'Snapshot Date']);
  assert.equal(headers.length, before.length + 1);
  const values = before.map((header, i) => header.endsWith('At') || header === 'Snapshot Date' ? new Date(2026, 9, i + 1) : header);
  const ordered = ctx.orderProjectIdSummaryBuiltRow_(values);
  headers.forEach((header, i) => {
    if (header === 'Days Between First and Last Email') assert.equal(ordered[i], 1);
    else assert.equal(ordered[i], values[before.indexOf(header)]);
  });
  assert.equal(headers.indexOf('Latest AI Email Received At'), 54);
});
test('physical migration preserves columns and is idempotent', () => {
  const ctx = setup();
  const before = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_ROW_BUILD_HEADERS', ctx));
  const expected = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS_BEFORE_EMAIL_DAYS', ctx));
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

test('elapsed email days round up and distinguish zero from missing or invalid dates', () => {
  const ctx = setup(); const first = new Date('2026-10-01T10:00:00Z');
  for (const [milliseconds, expected] of [[0,0],[1,1],[3600000,1],[86400000,1],[86400001,2],[2.3*86400000,3]]) {
    assert.equal(ctx.projectIdSummaryEmailDays_(first, new Date(first.getTime()+milliseconds)), expected);
  }
  assert.equal(ctx.projectIdSummaryEmailDays_('', first), '');
  assert.equal(ctx.projectIdSummaryEmailDays_(first, 'invalid'), '');
  assert.equal(ctx.projectIdSummaryEmailDays_(first, new Date(first.getTime()-1)), '');
});

test('email days migration inserts once before Snapshot Date without changing existing columns', () => {
  const ctx = setup(); const headers = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS_BEFORE_EMAIL_DAYS', ctx));
  let inserted = 0;
  const sheet = {insertColumnAfter: index => {assert.equal(index, 58); inserted++;}, getRange: (r,c) => ({setValue: value => {assert.equal(c,59); assert.equal(value,'Days Between First and Last Email');}})};
  ctx.insertProjectIdSummaryEmailDaysColumn_(sheet,headers);
  assert.deepEqual(headers, Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS_BEFORE_EMAIL_COUNT_MOVE',ctx)));
  ctx.insertProjectIdSummaryEmailDaysColumn_(sheet,headers); assert.equal(inserted,1);
  assert.match(source,/setNumberFormat\('0'\)\.setWrap\(true\)/);
});

test('Email Count physically moves before Snapshot Date, preserving values and avoiding duplicates', () => {
  const ctx = setup(); const headers = Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS_BEFORE_EMAIL_COUNT_MOVE',ctx));
  const physical = headers.slice(); let moves = 0;
  const sheet = {getMaxRows:()=>1000, getRange:(r,c,n,w)=>({c}), moveColumns:(range,destination)=>{
    assert.equal(range.c,32); assert.equal(destination,60);
    physical.splice(destination-2,0,physical.splice(range.c-1,1)[0]);moves++;
  }};
  ctx.moveProjectIdSummaryEmailCountColumn_(sheet,headers);
  assert.deepEqual(headers,Array.from(vm.runInContext('PROJECT_ID_SUMMARY_HEADERS',ctx)));
  assert.deepEqual(physical,headers);
  ctx.moveProjectIdSummaryEmailCountColumn_(sheet,headers);assert.equal(moves,1);
  assert.equal(headers.indexOf('Email Count'),58);
  assert.match(source,/projectIdSummaryColumn_\('Email Count'\), rowCount, 1\)[\s\S]*?PROJECT_METADATA_DATA_BACKGROUND/);
});
test('all four moved dates receive green headers and date styles after other styles', () => {
  assert.match(source, /PROJECT_ID_SUMMARY_TRAILING_DATE_HEADERS\.forEach\(header => \{[\s\S]*?PROJECT_METADATA_HEADER_BACKGROUND/);
  assert.match(source, /PROJECT_ID_SUMMARY_TRAILING_DATE_HEADERS\.forEach\(header => \{[\s\S]*?PROJECT_METADATA_DATA_BACKGROUND[\s\S]*?DATE_FORMAT/);
  assert.match(source, /getRange\(startRow, latestAiStartColumn, rowCount, 2\)[\s\S]*?setNumberFormat\('0\.###'\)/);
});

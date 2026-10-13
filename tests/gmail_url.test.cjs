const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
test('latest case email URL preserves message identifier and schema offsets', () => {
  const ctx = vm.createContext({console, Date});
  vm.runInContext(source, ctx);
  assert.equal(vm.runInContext("PROJECT_ID_SUMMARY_HEADERS.indexOf('Gmail Message ID')", ctx), 35);
  assert.equal(vm.runInContext("PROJECT_ID_SUMMARY_HEADERS.indexOf('Gmail URL')", ctx), 36);
  assert.equal(vm.runInContext("PROJECT_ID_SUMMARY_LATEST_AI_NUMERIC_START_INDEX === PROJECT_ID_SUMMARY_HEADERS.indexOf('Proposed Production kWh')", ctx), true);
  const rows = [['Case ID', 'Received At', 'Gmail Message ID', 'Google Group URL'],
    ['26-42-005919', new Date('2026-09-30T12:00:00Z'), 'new', 'https://groups.google.com/new'],
    ['26-42-005919', new Date('2026-09-29T12:00:00Z'), 'old', 'https://groups.google.com/old'],
    ['other', new Date('2026-10-01T12:00:00Z'), '', '']];
  const latest = ctx.loadProjectIdSummaryLatestArchivedEmails_({getSheetByName: () => ({
    getLastRow: () => rows.length, getLastColumn: () => 4, getName: () => 'Emails',
    getRange: () => ({getValues: () => rows})})});
  assert.equal(ctx.getProjectIdSummaryLatestGmailUrl_(['26-42-005919'], latest), 'https://groups.google.com/new');
  assert.equal(ctx.getProjectIdSummaryLatestGmailUrl_(['26-42-005919', 'other'], latest), '');
  assert.equal(ctx.getProjectIdSummaryLatestGmailUrl_(['missing'], latest), '');
});

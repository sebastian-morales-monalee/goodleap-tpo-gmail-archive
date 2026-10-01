const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8');
const context = vm.createContext({console});
vm.runInContext(source, context);

test('energy display formats have requested precision and preserve other formats', () => {
  const calls = [];
  context.projectIdSummaryColumn_ = header => header;
  const range = header => Object.fromEntries([
    'setNumberFormat', 'setShowHyperlink', 'setFontColor', 'setFontLine', 'setFontStyle', 'setFontWeight',
  ].map(method => [method, function(value) {calls.push([header, method, value]); return this;}]));
  const sheet = {getRange(row, header, count, width) {
    assert.equal(row, 2); assert.equal(count, 117); assert.equal(width, 1);
    return range(header);
  }};
  context.formatProjectIdSummaryEnergyRows_(sheet, 2, 117);
  const formats = Object.fromEntries(calls.filter(c => c[1] === 'setNumberFormat').map(c => [c[0], c[2]]));
  assert.equal(formats.panel_rated_power_w, '#,##0');
  assert.equal(formats.system_size_kw, '#,##0.00');
  assert.equal(formats.inverter_nominal_ac_power_w, '#,##0');
  assert.equal(formats.inverter_max_efficiency_percent, '#,##0.00');
  assert.equal(formats.reference_dc_production_kwh, '#,##0.0');
  assert.equal(formats.estimated_annual_ac_production_kwh, '#,##0.0');
  assert.equal(formats['Annual Energy Consumption kWh'], '#,##0');
  assert.equal(formats.dc_ac_ratio, '#,##0.000000');
  assert.equal(formats.dc_ac_correction_factor, '#,##0.000000');
  for (const [method, value] of [['setShowHyperlink', false], ['setFontColor', '#000000'],
    ['setFontLine', 'none'], ['setFontStyle', 'normal'], ['setFontWeight', 'normal']]) {
    assert.ok(calls.some(c => c[0] === 'system_size_kw' && c[1] === method && c[2] === value));
  }
  // No value-writing methods are exposed by the mock.
});

test('formatting skips empty sheets and is part of every row refresh', () => {
  context.formatProjectIdSummaryEnergyRows_({getRange() {throw new Error('empty');}}, 2, 0);
  assert.match(source, /function formatProjectIdSummaryRows_\([\s\S]*?formatProjectIdSummaryEnergyRows_\(sheet, startRow, rowCount\)/);
});

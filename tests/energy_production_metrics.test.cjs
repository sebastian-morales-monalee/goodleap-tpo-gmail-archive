const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({console});
for (const file of ['EnergyProductionMetrics.gs', 'ProjectIdSummary.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const example = {
  snapshotVersionId: 'aa604b23-fc06-49c0-a7b7-4ad7323344cf',
  snapshotDate: '2026-09-21T18:05:04.888-05:00',
  activePanelCount: 9, projectActivePanelCount: 9,
  panelRatedPowerW: 430, referenceDcProductionKwh: 3842.675949950245,
  selectedInverterJson: JSON.stringify({models: [{
    model: 'GL_ENPH1_IQ8HC-72-M-DOM-US (380 W)',
    nominalACPowerOutputW: 0, ratedACPowerW: 380, maxEfficiencyPercentage: null,
  }]}),
  catalogNominalAcPowerW: 380, catalogEfficiencyPercent: 97.3,
  inverterCountOverride: 9, inverterType: 'micro',
  panelsMissingProduction: 0, panelsWithDiurnalShape: 0,
  annualEnergyUseAcKwh: 5902, productionEngineVersion: '2',
};
const actual = context.calculateProjectEnergyMetrics_(example);
assert.equal(actual.activePanelCount, 9);
assert.equal(actual.inverterCount, 9);
assert.equal(actual.systemSizeKw, 3.87);
assert.ok(Math.abs(actual.estimatedAnnualAcProductionKwh - 4022.389215636849) < 0.001);
assert.equal(actual.estimatedOffsetPercent, 68);
assert.match(actual.energyCalculationStatus, /catalog fallback/);
assert.equal(actual.snapshotDate.toISOString(), '2026-09-21T23:05:04.888Z');
const sales = context.calculateProjectEnergyMetrics_({...example,
  snapshotVersionId: '80c4c67b-d2cf-4809-ada2-42df895ec044',
  activePanelCount: 20, projectActivePanelCount: 20, inverterCountOverride: null,
  referenceDcProductionKwh: 11473.880950039056,
  selectedInverterJson: JSON.stringify({models: [{
    nominalACPowerOutputW: 11500, maxEfficiencyPercentage: 97.5,
  }]}), inverterType: 'string', annualEnergyUseAcKwh: 8433,
});
assert.equal(sales.activePanelCount, 20);
assert.equal(sales.inverterCount, 1);
assert.equal(sales.systemSizeKw, 8.6);
assert.ok(Math.abs(sales.estimatedAnnualAcProductionKwh - 11995.002859830853) < 0.001);
assert.equal(sales.estimatedOffsetPercent, 142);
assert.equal(sales.energyCalculationStatus, 'Calculated from latest saved snapshot');
// An override affects physical inverter count, never the DC panel selection.
assert.equal(context.calculateProjectEnergyMetrics_({...example,
  inverterCountOverride: 10}).activePanelCount, 9);
assert.equal(context.calculateProjectEnergyMetrics_({...example,
  inverterCountOverride: 0}).inverterCount, null);
assert.equal(context.calculateProjectEnergyMetrics_({...example,
  inverterCountOverride: null}).inverterCount, 9);
for (const change of [{panelsMissingProduction: 1}, {panelsWithDiurnalShape: 1},
  {productionEngineVersion: '1'}, {inverterType: ''}]) {
  assert.equal(context.calculateProjectEnergyMetrics_({...example, ...change})
    .estimatedAnnualAcProductionKwh, null);
}
assert.equal(context.calculateProjectEnergyMetrics_({...example,
  snapshotVersionId: null}).activePanelCount, undefined);
assert.match(context.calculateProjectEnergyMetrics_({...example,
  snapshotVersionId: null}).energyCalculationStatus, /No saved snapshot/);
assert.equal(context.calculateProjectEnergyMetrics_({...example,
  annualEnergyUseAcKwh: 0}).estimatedOffsetPercent, null);
assert.ok(context.calculateProjectEnergyMetrics_({...example,
  projectActivePanelCount: 38}).referenceDcProductionKwh > 0);
const schema = vm.runInContext(`({current:PROJECT_ID_SUMMARY_HEADERS,
  previous:LEGACY_PROJECT_ID_SUMMARY_HEADERS_V17,
  energy:PROJECT_ID_SUMMARY_ENERGY_HEADERS})`, context);
// Eight snapshot fields plus both link columns, minus the 21 disabled optional deltas.
assert.equal(schema.current.length - schema.previous.length, 8 + 2 - 21);
assert.equal(schema.current.indexOf('active_panel_count'), 7);
assert.equal(schema.current.indexOf('reference_dc_production_kwh'), 14);
assert.equal(schema.current.indexOf('Snapshot Date'), 20);
assert.equal(context.projectEnergyMetricCells_(actual).length, schema.energy.length);
// Schema migration shifts only by header name, preserving email/category fields.
let migrated;
const previous = Array.from(schema.previous);
const sourceRow = previous.map((header) => `saved:${header}`);
sourceRow[previous.indexOf('Proposed Production kWh')] = 100;
sourceRow[previous.indexOf('Benchmark Production kWh')] = 100;
context.setProjectIdSummaryRichLinks_ = () => {};
context.migrateProjectIdSummarySchema_({getLastRow: () => 2,
  getRange: () => ({getValues: () => [sourceRow], clearContent: () => {},
    setValues: (rows) => {migrated=rows[0];}})}, schema.previous);
for (const header of ['Project ID','AI Summary','Categories','Gmail Message ID',
  'Required Evidence','Technical Notes','Annual Energy Consumption kWh']) {
  assert.equal(migrated[schema.current.indexOf(header)], sourceRow[previous.indexOf(header)]);
}
assert.equal(migrated[schema.current.indexOf('Snapshot Version ID')], '');
const snapshotHeaders = vm.runInContext('LEGACY_PROJECT_ID_SUMMARY_HEADERS_V18', context);
assert.equal(schema.current.length - snapshotHeaders.length, 4 + 2 - 21);
assert.deepEqual(Array.from(schema.current.slice(24,28)),
  ['kWh/kW','kWh/kW >= MIN','Offset <= 110%','110 % < offset ≤ 150 %']);
assert.equal(schema.current.indexOf('Solar Panel'),28);
const rules = context.goodLeapConditionalLookup_(context.defaultGoodLeapConditionalRows_());
assert.equal(rules.size,50); // 49 states plus DC; RI was not supplied.
assert.equal(rules.has('RI'),false);
for (const [state,min] of rules) {
  assert.equal(context.projectIdSummaryConditionalCells_({systemSizeKw:1,
    estimatedAnnualAcProductionKwh:min},state,rules)[1],true);
  assert.equal(context.projectIdSummaryConditionalCells_({systemSizeKw:1,
    estimatedAnnualAcProductionKwh:min-0.001},state,rules)[1],false);
}
for (const [offset,standard,band] of [[0,true,false],[110,true,false],
  [110.001,false,true],[150,false,true],[150.001,false,false]]) {
  assert.deepEqual(Array.from(context.projectIdSummaryConditionalCells_(
    {estimatedOffsetPercent:offset},'CT',rules).slice(2)),[standard,band]);
}
assert.deepEqual(Array.from(context.projectIdSummaryConditionalCells_({},'CT',rules)),['','','','']);
assert.equal(context.projectIdSummaryConditionalCells_({systemSizeKw:0,
  estimatedAnnualAcProductionKwh:900},'CT',rules)[0],'');
assert.equal(context.projectIdSummaryConditionalCells_({systemSizeKw:1,
  estimatedAnnualAcProductionKwh:900},'RI',rules)[1],'');
assert.equal(context.projectIdSummaryConditionalCells_({systemSizeKw:1,
  estimatedAnnualAcProductionKwh:700},' ct ',rules)[1],true);
assert.throws(()=>context.goodLeapConditionalLookup_([['CT',700],['CT',800]]),/duplicate/);
assert.throws(()=>context.goodLeapConditionalLookup_([['CT','']]),/invalid/);
const formulas=Array.from(context.projectIdSummaryConditionalFormulas_(118,51));
assert.match(formulas[0],/R118\/J118/);
assert.match(formulas[1],/UPPER\(TRIM\(F118\)\)/);
assert.match(formulas[1],/\$A\$2:\$B\$51/);
assert.match(formulas[2],/T118<=110/);
assert.match(formulas[3],/T118>110,T118<=150/);
const snapshotRow = Array.from(snapshotHeaders, h => `preserved:${h}`);
context.migrateProjectIdSummarySchema_({getLastRow:()=>2,getRange:()=>({
  getValues:()=>[snapshotRow],clearContent:()=>{},setValues:rows=>{migrated=rows[0];}})},snapshotHeaders);
for(const h of ['Snapshot Version ID','Energy Calculation Status','AI Summary','Categories','State']) {
  assert.equal(migrated[schema.current.indexOf(h)],snapshotRow[snapshotHeaders.indexOf(h)]);
}
context.postHogStringLiteral_ = (value) => `'${value}'`;
const query = context.buildProjectIdSummaryEnergyQuery_(
  ['f8c08b92-ce68-453b-9353-210e41c2d149'], 'goodleap_postgres_projects');
assert.match(query, /goodleap_postgres_projectversions/);
assert.match(query, /PARTITION BY project_id, organization_id/);
assert.match(query, /ORDER BY created_at DESC, id DESC/);
assert.match(query, /v.organization_id = p.organization_id/);
assert.match(query, /pv.id = v.pricing_version_id/);
assert.match(query, /v.inverter_type_id/);
assert.match(query, /panelAnnualProdDckwh/);
assert.match(query, /'null', '\[\]'/);
assert.ok(!query.includes('solarpanels'));
assert.ok(!query.includes('panel_capacity_watts'));
const selected = {model: {model: 'EXAMPLE (11500 W)'}};
const catalog = [{id:'one', model_number:'EXAMPLE', count_strategy:'string'},
  {id:'two', model_number:'EXAMPLE', count_strategy:'STRING'}];
assert.equal(context.projectEnergyResolveCatalogModel_(selected, catalog).count_strategy, 'string');
assert.equal(context.projectEnergyResolveCatalogModel_(selected,
  [catalog[0], {...catalog[1], count_strategy:'micro'}]), null);
context.getPostHogSolarSettings_ = () => ({
  goodLeapProjectsTable:'goodleap_postgres_projects',
  artemisSalesProjectsTable:'artemis_sales_postgres_projects',
});
context.chunkPostHogArray_ = (items) => [items];
const id = 'f8c08b92-ce68-453b-9353-210e41c2d149';
let calls = [];
context.executePostHogHogQL_ = (sql) => {
  calls.push(sql);
  if (sql.includes('invertermodels')) return {columns:['id','model_number','count_strategy',
    'nominal_ac_power_output_w','max_efficiency_percentage'],
    results:[['model','GL_ENPH1_IQ8HC-72-M-DOM-US','micro',380,97.3]]};
  if (sql.includes('FROM goodleap_postgres_projects AS p')) return {columns:['project_id'],results:[]};
  return {columns:['project_id','snapshot_version_id','snapshot_date','active_panel_count',
    'project_active_panel_count','panel_rated_power_w','reference_dc_production_kwh',
    'selected_inverter_json','inverter_count_override','panels_with_diurnal_shape',
    'annual_energy_use_ackwh','production_engine_version','panels_missing_production'],
  results:[[id,example.snapshotVersionId,example.snapshotDate,9,9,430,
    example.referenceDcProductionKwh,example.selectedInverterJson,9,0,5902,'2',0]]};
};
assert.equal(context.fetchProjectIdSummaryEnergyMetrics_([id]).get(id).estimatedOffsetPercent,68);
assert.ok(calls.some((sql) => sql.includes('artemis_sales_postgres_projectversions')));
calls = [];
context.executePostHogHogQL_ = (sql) => {calls.push(sql);throw Error('test failure');};
assert.match(context.fetchProjectIdSummaryEnergyMetrics_([id]).get(id)
  .energyCalculationStatus,/query failed/);
assert.equal(calls.length,1);
console.log('Snapshot energy metric tests passed.');

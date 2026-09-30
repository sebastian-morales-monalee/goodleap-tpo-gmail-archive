const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'EnergyProductionMetrics.gs'), 'utf8',
);
const context = vm.createContext({ console, Math, JSON, Number, String });
vm.runInContext(source, context);

const example = {
  activePanelCount: 22,
  projectActivePanelCount: 22,
  panelRatedPowerW: 430,
  referenceDcProductionKwh: 12704.415322428453,
  selectedInverterJson: JSON.stringify({
    brand: 'ENPHASE',
    models: [{ model: 'IQ8HC microinverter',
      nominalACPowerOutputW: 380, maxEfficiencyPercentage: 97.3 }],
  }),
  inverterModelOverride: null,
  inverterCountOverride: null,
  inverterType: 'micro',
  panelsWithDiurnalShape: 0,
  activeHomeApplianceCount: 0,
  annualEnergyUseAcKwh: 13447,
  productionEngineVersion: '3',
};
const actual = context.calculateProjectEnergyMetrics_(example);
assert.equal(actual.activePanelCount, 22);
assert.equal(actual.inverterCount, 22);
assert.equal(actual.systemSizeKw, 9.46);
assert.ok(Math.abs(actual.dcAcRatio - 1.131578947) < 1e-8);
assert.ok(Math.abs(actual.dcAcCorrectionFactor - 1.000757895) < 1e-8);
assert.ok(Math.abs(actual.estimatedAnnualAcProductionKwh - 13298.572102) < 0.001);
assert.equal(Math.round(actual.estimatedAnnualAcProductionKwh), 13299);
assert.equal(actual.estimatedOffsetPercent, 98);

vm.runInContext(fs.readFileSync(
  path.join(__dirname, '..', 'ProjectIdSummary.gs'), 'utf8',
), context);
const schema = vm.runInContext(`({
  current: PROJECT_ID_SUMMARY_HEADERS,
  previous: LEGACY_PROJECT_ID_SUMMARY_HEADERS_V16,
  energy: PROJECT_ID_SUMMARY_ENERGY_HEADERS,
})`, context);
assert.equal(schema.current.length - schema.previous.length, 13);
assert.equal(schema.current.indexOf('active_panel_count'),
  schema.current.indexOf('Region') + 1);
assert.equal(schema.current.filter((header) =>
  header === 'Engine Version').length, 1);
assert.equal(schema.current.indexOf('Solar Panel'),
  schema.current.indexOf('Region') + schema.energy.length + 1);
context.postHogStringLiteral_ = (value) => `'${value}'`;
const query = context.buildProjectIdSummaryEnergyQuery_(
  ['d4261513-53c6-4740-ab32-c9f808b0e491'],
  'goodleap_postgres_projects',
);
assert.ok(query.includes('goodleap_postgres_pricingversions'));
assert.ok(query.includes('goodleap_postgres_solarpanels'));
assert.ok(!query.includes('projecthomeappliances'));
assert.ok(query.includes('panel_annual_prod_dckwh'));
assert.ok(query.includes("'capacity_watts'"));
assert.ok(!query.includes('panel_capacity_watts'));

assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, inverterCountOverride: 2,
}).inverterCount, 2);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, inverterType: 'string', selectedInverterJson: JSON.stringify({brand: 'OTHER', models: [
    {model: 'String inverter', nominalACPowerOutputW: 380,
      maxEfficiencyPercentage: 97.3},
  ]}),
}).inverterCount, 1);
assert.equal(context.calculateProjectEnergyMetrics_({...example, inverterType: ''}).inverterCount, null);
assert.equal(actual.annualEnergyConsumptionKwh, 13447);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, panelsWithDiurnalShape: 1,
}).estimatedAnnualAcProductionKwh, null);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, activeHomeApplianceCount: 1,
}).estimatedOffsetPercent, 98);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, productionEngineVersion: '1',
}).estimatedAnnualAcProductionKwh, null);

// A source-specific catalogue lookup, not the inverter brand, determines type.
context.getPostHogSolarSettings_ = () => ({
  goodLeapProjectsTable: 'goodleap_postgres_projects',
  artemisSalesProjectsTable: 'artemis_sales_postgres_projects',
});
context.chunkPostHogArray_ = (items) => [items];
const exampleId = 'd4261513-53c6-4740-ab32-c9f808b0e491';
const modelId = '6b16431f-b6a0-4b7d-853c-1014307fdf0a';
const calls = [];
context.executePostHogHogQL_ = (sql) => {
  calls.push(sql);
  if (sql.includes('invertermodels')) return {
    columns: ['id', 'model_number', 'count_strategy', 'nominal_ac_power_output_w',
      'max_efficiency_percentage'], results: [[modelId, 'EXAMPLE', 'micro', 380, 97.3]],
  };
  if (sql.includes('FROM goodleap_postgres_projects AS p')) return {
    columns: ['project_id'], results: [],
  };
  return {
    columns: ['project_id', 'active_panel_count', 'panel_rated_power_w',
      'reference_dc_production_kwh', 'selected_inverter_json',
      'inverter_model_override', 'inverter_count_override',
      'panels_with_diurnal_shape', 'annual_energy_use_ackwh',
      'production_engine_version', 'project_active_panel_count'],
    results: [[exampleId, 22, 430, example.referenceDcProductionKwh,
      JSON.stringify({brand: 'Not used to infer type', models: [{id: modelId,
        nominalACPowerOutputW: 380, maxEfficiencyPercentage: 97.3}]}),
      null, null, 0, 13447, '3', 22]],
  };
};
const fallback = context.fetchProjectIdSummaryEnergyMetrics_([exampleId]).get(exampleId);
assert.equal(fallback.inverterType, 'micro');
assert.equal(fallback.inverterCount, 22);
assert.equal(fallback.estimatedOffsetPercent, 98);
assert.ok(calls.some((sql) => sql.includes('artemis_sales_postgres_invertermodels')));

const corrected = context.calculateProjectEnergyMetrics_({
  ...example, activePanelCount: 65, projectActivePanelCount: 22,
});
assert.equal(corrected.activePanelCount, 22);
assert.equal(corrected.inverterCount, 22);
assert.equal(corrected.systemSizeKw, 9.46);
assert.equal(corrected.referenceDcProductionKwh, null);
assert.equal(corrected.estimatedAnnualAcProductionKwh, null);
assert.equal(corrected.estimatedOffsetPercent, null);
const overrideCorrected = context.calculateProjectEnergyMetrics_({
  ...example, activePanelCount: 45, projectActivePanelCount: 10,
  inverterCountOverride: 10, panelRatedPowerW: 435,
});
assert.equal(overrideCorrected.activePanelCount, 10);
assert.equal(overrideCorrected.systemSizeKw, 4.35);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, inverterType: 'string', inverterCountOverride: 7,
}).inverterCount, 1);
assert.equal(context.calculateProjectEnergyMetrics_({
  ...example, projectActivePanelCount: null,
}).inverterCount, null);
const legacySelected = {model: {model: 'GL_ENPH1_IQ8HC-72-M-DOM-US (380 W)'}};
const catalogModel = {id: modelId, model_number: 'GL_ENPH1_IQ8HC-72-M-DOM-US'};
assert.equal(context.projectEnergyResolveCatalogModel_(legacySelected, [catalogModel]), catalogModel);
assert.equal(context.projectEnergyResolveCatalogModel_(legacySelected, [catalogModel, catalogModel]), null);
const teslaSelected = {model: {model: 'Tesla Powerwall 3 (integrated inverter) (1707000-21) (11500 W)'}};
const teslaCatalog = [
  {id: 'one', model_number: 'Tesla Powerwall 3 (integrated inverter) (1707000-21)',
    count_strategy: 'string', nominal_ac_power_output_w: 11500, max_efficiency_percentage: 97.5},
  {id: 'two', model_number: 'Tesla Powerwall 3 (integrated inverter) (1707000-21)',
    count_strategy: ' STRING ', nominal_ac_power_output_w: null, max_efficiency_percentage: null},
];
const agreedType = context.projectEnergyResolveCatalogModel_(teslaSelected, teslaCatalog);
assert.equal(agreedType.count_strategy, 'string');
assert.equal(agreedType.nominal_ac_power_output_w, undefined);
assert.equal(context.projectEnergyResolveCatalogModel_(teslaSelected,
  [teslaCatalog[0], {...teslaCatalog[1], count_strategy: 'micro'}]), null);
assert.equal(context.projectEnergyResolveCatalogModel_(teslaSelected,
  [teslaCatalog[0], {...teslaCatalog[1], count_strategy: null}]), null);
const teslaMetrics = context.calculateProjectEnergyMetrics_({
  ...example, activePanelCount: 20, projectActivePanelCount: 20,
  selectedInverterJson: JSON.stringify({models: [{...teslaSelected.model,
    nominalACPowerOutputW: 11500, maxEfficiencyPercentage: 97.5}]}),
  inverterType: agreedType.count_strategy,
});
assert.equal(teslaMetrics.inverterType, 'string');
assert.equal(teslaMetrics.inverterCount, 1);
assert.equal(teslaMetrics.inverterNominalAcPowerW, 11500);
assert.equal(teslaMetrics.inverterMaxEfficiencyPercent, 97.5);
const legacyMetrics = context.calculateProjectEnergyMetrics_({
  ...example, selectedInverterJson: JSON.stringify({models: [
    {model: 'Legacy model', nominalACPowerOutputW: 0, maxEfficiencyPercentage: null},
  ]}), catalogNominalAcPowerW: 380, catalogEfficiencyPercent: 97.3,
});
assert.equal(legacyMetrics.inverterNominalAcPowerW, 380);
assert.equal(legacyMetrics.inverterMaxEfficiencyPercent, 97.3);

console.log('Energy production metric tests passed.');

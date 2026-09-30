/**
 * Conservative Artemis V2/V3 energy metrics for Project ID Summary.
 * A missing source or an ambiguous physical inverter count produces a blank
 * derived metric, never a guessed value. The source panel_capacity_watts field
 * is intentionally not used: it is not the panel's rated power.
 */
const PROJECT_ENERGY_DC_AC_FACTORS = [
  [0.4, 0.9892], [0.5, 0.9922], [0.6, 0.9952], [0.7, 0.9967],
  [0.8, 0.9982], [0.9, 0.9991], [1.0, 1.0], [1.1, 1.0006],
  [1.2, 1.0011], [1.3, 0.9979], [1.4, 0.9947], [1.5, 0.9807],
  [1.6, 0.9667], [1.7, 0.9456], [1.8, 0.9245], [1.9, 0.9018],
  [2.0, 0.8790],
];

function projectEnergyFinitePositive_(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function projectEnergyCorrectionFactor_(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0.4 || ratio > 2.0) return null;
  for (let index = 1; index < PROJECT_ENERGY_DC_AC_FACTORS.length; index++) {
    const [r1, f1] = PROJECT_ENERGY_DC_AC_FACTORS[index];
    if (ratio <= r1) {
      const [r0, f0] = PROJECT_ENERGY_DC_AC_FACTORS[index - 1];
      return f0 + ((ratio - r0) / (r1 - r0)) * (f1 - f0);
    }
  }
  return null;
}

function projectEnergySelectedInverterModel_(rawJson, modelOverride) {
  let inverter;
  try {
    inverter = JSON.parse(String(rawJson || '{}'));
  } catch (error) {
    return null;
  }
  if (!inverter || !Array.isArray(inverter.models)) return null;
  const override = String(modelOverride || '').trim().toLowerCase();
  const models = inverter.models;
  const model = override
    ? models.find((item) =>
        String(item.id || '').toLowerCase() === override ||
        String(item.model || '').toLowerCase() === override)
    : models.length === 1 ? models[0] : null;
  return model ? { inverter, model } : null;
}

function projectEnergyModelNumber_(value) {
  return String(value || '').trim().replace(/\s*\([\d.,]+\s*[kK]?[wW]\)\s*$/, '')
    .trim().toUpperCase();
}

function projectEnergyResolveCatalogModel_(selected, catalog) {
  if (!selected) return null;
  const id = String(selected.model.id || '').toLowerCase();
  const matches = id
    ? catalog.filter((model) => String(model.id).toLowerCase() === id)
    : catalog.filter((model) => projectEnergyModelNumber_(model.model_number) ===
      projectEnergyModelNumber_(selected.model.model));
  if (matches.length === 1) return matches[0];
  if (!matches.length) return null;
  const strategies = matches.map((model) =>
    String(model.count_strategy || '').trim().toLowerCase());
  if (!strategies[0] || strategies.some((type) => type !== strategies[0])) return null;
  // Resolve only the agreed type; do not choose arbitrary catalogue metadata.
  return {count_strategy: strategies[0]};
}

function calculateProjectEnergyMetrics_(source) {
  const rawPanelCount = projectEnergyFinitePositive_(
    source.activePanelCount,
  );
  const projectPanelCount = projectEnergyFinitePositive_(source.projectActivePanelCount);
  const ratedW = projectEnergyFinitePositive_(source.panelRatedPowerW);
  const selected = projectEnergySelectedInverterModel_(
    source.selectedInverterJson,
    source.inverterModelOverride,
  );
  const inverterW = (selected && projectEnergyFinitePositive_(
    selected.model.nominalACPowerOutputW,
  )) || projectEnergyFinitePositive_(source.catalogNominalAcPowerW);
  const efficiency = (selected && projectEnergyFinitePositive_(
    selected.model.maxEfficiencyPercentage,
  )) || projectEnergyFinitePositive_(source.catalogEfficiencyPercent);
  const overrideCount = projectEnergyFinitePositive_(
    source.inverterCountOverride,
  );
  const inverterType = String(source.inverterType || '').trim().toLowerCase();
  const inverterCount = inverterType === 'micro'
    ? overrideCount || projectPanelCount
    : inverterType ? 1 : null;
  const activePanelCount = inverterType === 'micro'
    ? inverterCount : inverterType ? rawPanelCount : projectPanelCount;
  // Count correction does not select the individual records to sum for DC.
  const panelRecordsMatch = Boolean(activePanelCount && rawPanelCount &&
    activePanelCount === rawPanelCount &&
    (!projectPanelCount || projectPanelCount === rawPanelCount));
  const referenceDcKwh = panelRecordsMatch
    ? projectEnergyFinitePositive_(source.referenceDcProductionKwh) : null;
  const systemSizeKw = activePanelCount && ratedW
    ? activePanelCount * ratedW / 1000
    : null;
  const ratio = activePanelCount && ratedW && inverterCount && inverterW
    ? activePanelCount * ratedW / (inverterCount * inverterW)
    : null;
  const factor = ratio === null ? null : projectEnergyCorrectionFactor_(ratio);
  const engine = String(source.productionEngineVersion || '').trim();
  const noDiurnalCurves = Number(source.panelsWithDiurnalShape) === 0;
  const estimatedAcKwh = ['2', '3'].includes(engine) && noDiurnalCurves &&
      referenceDcKwh && ratedW && efficiency && factor !== null
    ? referenceDcKwh * (ratedW / 400) * (efficiency / 100) * factor
    : null;
  const annualConsumption = projectEnergyFinitePositive_(
    source.annualEnergyUseAcKwh,
  );
  // annual_energy_use_ackwh already includes the energy-efficiency adjustment.
  const estimatedOffset = estimatedAcKwh !== null && annualConsumption
    ? Math.trunc(estimatedAcKwh / annualConsumption * 100)
    : null;
  return {
    rawPanelCount, projectPanelCount, panelRecordsMatch,
    activePanelCount, panelRatedPowerW: ratedW, systemSizeKw,
    inverterType,
    inverterNominalAcPowerW: inverterW || null,
    inverterCount: inverterCount || null,
    inverterMaxEfficiencyPercent: efficiency || null,
    referenceDcProductionKwh: referenceDcKwh,
    dcAcRatio: ratio, dcAcCorrectionFactor: factor,
    estimatedAnnualAcProductionKwh: estimatedAcKwh,
    annualEnergyConsumptionKwh: annualConsumption,
    estimatedOffsetPercent: estimatedOffset,
  };
}

function projectEnergyMetricCells_(metrics) {
  const values = metrics || {};
  return [
    values.activePanelCount, values.panelRatedPowerW,
    values.systemSizeKw, values.inverterType, values.inverterNominalAcPowerW,
    values.inverterCount, values.inverterMaxEfficiencyPercent,
    values.referenceDcProductionKwh, values.dcAcRatio,
    values.dcAcCorrectionFactor,
    values.estimatedAnnualAcProductionKwh,
    values.annualEnergyConsumptionKwh,
    values.estimatedOffsetPercent,
  ].map((value) => value === null || value === undefined ? '' : value);
}

function fetchProjectIdSummaryEnergyMetrics_(projectIds) {
  const uniqueIds = Array.from(new Set(projectIds.map((id) =>
    String(id || '').trim().toLowerCase()).filter(isProjectIdSummaryUuid_)));
  const settings = getPostHogSolarSettings_();
  const sources = [
    { table: settings.goodLeapProjectsTable, label: 'GoodLeap' },
    { table: settings.artemisSalesProjectsTable, label: 'Artemis Sales' },
  ];
  const byProjectId = new Map();
  let unresolved = uniqueIds;
  sources.forEach((source) => {
    if (!unresolved.length) return;
    chunkPostHogArray_(unresolved, PROJECT_ID_SUMMARY_CONFIG.MAP_QUERY_BATCH_SIZE)
      .forEach((batch) => {
        const query = buildProjectIdSummaryEnergyQuery_(batch, source.table);
        try {
          const response = executePostHogHogQL_(
            query, `goodleap_apps_script_${source.label.replace(/\s/g, '_')}_energy`,
          );
          const indexes = {};
          response.columns.forEach((column, index) => {
            indexes[String(column).toLowerCase()] = index;
          });
          const selectedModels = response.results.map((row) =>
            projectEnergySelectedInverterModel_(
              row[indexes.selected_inverter_json],
              row[indexes.inverter_model_override],
            ));
          const modelIds = Array.from(new Set(selectedModels.filter(Boolean)
            .map((selected) => String(selected.model.id || '').toLowerCase())
            .filter(isProjectIdSummaryUuid_)));
          const modelNames = Array.from(new Set(selectedModels.filter(Boolean)
            .filter((selected) => !selected.model.id)
            .map((selected) => projectEnergyModelNumber_(selected.model.model))
            .filter(Boolean)));
          const catalog = [];
          if (modelIds.length || modelNames.length) {
            const modelTable = projectIdSummaryRelatedTable_(source.table, 'invertermodels');
            const filters = [];
            if (modelIds.length) filters.push('id IN (' +
              modelIds.map(postHogStringLiteral_).join(', ') + ')');
            if (modelNames.length) filters.push('upper(model_number) IN (' +
              modelNames.map(postHogStringLiteral_).join(', ') + ')');
            const modelResponse = executePostHogHogQL_(
              `SELECT id, model_number, count_strategy, nominal_ac_power_output_w, ` +
              `max_efficiency_percentage FROM ${modelTable} WHERE ` +
              filters.join(' OR ') + ' LIMIT 500',
              'goodleap_apps_script_inverter_count_strategy',
            );
            if (modelResponse.results.length >= 500) {
              throw new Error('Inverter catalogue lookup reached its limit; uniqueness is unknown.');
            }
            modelResponse.results.forEach((row) => catalog.push(Object.fromEntries(
              modelResponse.columns.map((column, index) => [column, row[index]]),
            )));
          }
          response.results.forEach((row, rowIndex) => {
            const id = String(row[indexes.project_id] || '').toLowerCase();
            if (!isProjectIdSummaryUuid_(id) || byProjectId.has(id)) return;
            const get = (name) => row[indexes[name]];
            const model = projectEnergyResolveCatalogModel_(selectedModels[rowIndex], catalog);
            byProjectId.set(id, calculateProjectEnergyMetrics_({
              activePanelCount: get('active_panel_count'),
              projectActivePanelCount: get('project_active_panel_count'),
              panelRatedPowerW: get('panel_rated_power_w'),
              referenceDcProductionKwh: get('reference_dc_production_kwh'),
              selectedInverterJson: get('selected_inverter_json'),
              inverterModelOverride: get('inverter_model_override'),
              inverterCountOverride: get('inverter_count_override'),
              inverterType: model && model.count_strategy,
              catalogNominalAcPowerW: model && model.nominal_ac_power_output_w,
              catalogEfficiencyPercent: model && model.max_efficiency_percentage,
              panelsWithDiurnalShape: get('panels_with_diurnal_shape'),
              annualEnergyUseAcKwh: get('annual_energy_use_ackwh'),
              productionEngineVersion: get('production_engine_version'),
            }));
          });
        } catch (error) {
          console.error(`[PROJECT ENERGY ERROR] ${source.label}: ${error}`);
        }
      });
    unresolved = unresolved.filter((id) => !byProjectId.has(id));
  });
  return byProjectId;
}

function buildProjectIdSummaryEnergyQuery_(projectIds, projectsTable) {
  const literals = projectIds.map(postHogStringLiteral_).join(', ');
  const pricingTable = projectIdSummaryRelatedTable_(
    projectsTable, 'pricingversions',
  );
  const panelsTable = projectIdSummaryRelatedTable_(
    projectsTable, 'solarpanels',
  );
  return [
    'SELECT p.id AS project_id,',
    '  p.active_panels_count AS project_active_panel_count,',
    '  pa.active_panel_count, pa.reference_dc_production_kwh,',
    '  pa.panels_with_diurnal_shape,',
    "  JSONExtractFloat(arrayFirst(x -> JSONExtractString(x, 'id') =",
    '    p.solar_panel_type_id,',
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'solar_panels')),",
    "    'capacity_watts') AS panel_rated_power_w,",
    "  arrayFirst(x -> JSONExtractString(x, 'id') = p.inverter_type_id,",
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'inverters'))",
    '    AS selected_inverter_json,',
    '  p.inverter_model_override, p.inverter_count_override,',
    '  p.annual_energy_use_ackwh, p.production_engine_version',
    `FROM ${projectsTable} AS p`,
    `LEFT ANY JOIN ${pricingTable} AS pv ON pv.id = p.pricing_version_id`,
    'LEFT ANY JOIN (SELECT project_id,',
    '  countIf(is_active = true) AS active_panel_count,',
    '  sumIf(panel_annual_prod_dckwh, is_active = true)',
    '    AS reference_dc_production_kwh,',
    "  countIf(is_active = true AND length(coalesce(diurnal_dc_shape, '')) > 0)",
    '    AS panels_with_diurnal_shape',
    `  FROM ${panelsTable} WHERE project_id IN (${literals})`,
    '  GROUP BY project_id) AS pa ON pa.project_id = p.id',
    `WHERE p.id IN (${literals})`,
    `LIMIT ${Math.max(projectIds.length * 2, projectIds.length)}`,
  ].join('\n');
}

/** Read-only PostHog check before publishing the migrated summary. */
function validateArtemisEnergyProjectExample() {
  const projectId = 'd4261513-53c6-4740-ab32-c9f808b0e491';
  const metrics = fetchProjectIdSummaryEnergyMetrics_([projectId]).get(projectId);
  if (!metrics) throw new Error(`PostHog did not return ${projectId}.`);
  const checks = {
    inverterType: metrics.inverterType === 'micro',
    inverterCount: metrics.inverterCount === 22,
    annualConsumption: metrics.annualEnergyConsumptionKwh === 13447,
    systemSizeKw: Math.abs(metrics.systemSizeKw - 9.46) < 0.000001,
    productionKwh:
      Math.abs(metrics.estimatedAnnualAcProductionKwh - 13298.572102) < 0.001,
    offsetPercent: metrics.estimatedOffsetPercent === 98,
  };
  const result = {projectId, metrics, checks, passed: Object.values(checks)
    .every(Boolean)};
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error('Example project energy validation failed.');
  return result;
}

/** Read-only regression validation for both reported count discrepancies. */
function validateArtemisPanelCountRules() {
  const examples = [
    {id: '05d70604-d371-4c91-b5c0-a2d075cec526', count: 10, size: 4.35},
    {id: 'd4f658cb-dcaf-4efd-bd08-9a84c1ed0dd6', count: 22, size: 9.46},
  ];
  const metrics = fetchProjectIdSummaryEnergyMetrics_(examples.map((item) => item.id));
  const results = examples.map((item) => {
    const value = metrics.get(item.id);
    const passed = Boolean(value && value.inverterType === 'micro' &&
      value.activePanelCount === item.count && value.inverterCount === item.count &&
      Math.abs(value.systemSizeKw - item.size) < 0.000001 &&
      value.inverterNominalAcPowerW === 380 &&
      value.inverterMaxEfficiencyPercent === 97.3 &&
      value.panelRecordsMatch === false && value.referenceDcProductionKwh === null &&
      value.estimatedAnnualAcProductionKwh === null && value.estimatedOffsetPercent === null);
    return {projectId: item.id, metrics: value, passed};
  });
  console.log(JSON.stringify(results, null, 2));
  if (!results.every((item) => item.passed)) {
    throw new Error('Provisional panel-count validation failed.');
  }
  return results;
}

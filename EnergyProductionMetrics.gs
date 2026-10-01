/**
 * Artemis V2/V3 energy metrics from the latest saved ProjectVersion.
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
  if (!source.snapshotVersionId) return {
    energyCalculationStatus: source.errorReason || 'No saved snapshot found',
  };
  const rawPanelCount = projectEnergyFinitePositive_(
    source.activePanelCount,
  );
  const projectPanelCount = projectEnergyFinitePositive_(source.projectActivePanelCount);
  const ratedW = projectEnergyFinitePositive_(source.panelRatedPowerW);
  const selected = projectEnergySelectedInverterModel_(
    source.selectedInverterJson,
    source.inverterModelOverride,
  );
  const pricingInverterW = selected && (projectEnergyFinitePositive_(
    selected.model.nominalACPowerOutputW,
  ) || projectEnergyFinitePositive_(selected.model.ratedACPowerW));
  const inverterW = pricingInverterW || projectEnergyFinitePositive_(source.catalogNominalAcPowerW);
  const pricingEfficiency = selected && projectEnergyFinitePositive_(
    selected.model.maxEfficiencyPercentage,
  );
  const efficiency = pricingEfficiency || projectEnergyFinitePositive_(source.catalogEfficiencyPercent);
  const overrideCount = projectEnergyFinitePositive_(
    source.inverterCountOverride,
  );
  const inverterType = String(source.inverterType || '').trim().toLowerCase();
  const inverterCount = inverterType === 'micro'
    ? (source.inverterCountOverride === null || source.inverterCountOverride === undefined ||
      source.inverterCountOverride === '' ? rawPanelCount : overrideCount)
    : inverterType ? 1 : null;
  // Both count and DC now refer to the same active records in one saved version.
  // An inverter override must not change which solar-panel records are summed.
  const activePanelCount = rawPanelCount;
  const panelRecordsMatch = Boolean(activePanelCount &&
    Number(source.panelsMissingProduction || 0) === 0);
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
  const reasons = [];
  if (!activePanelCount) reasons.push('No active panels in snapshot');
  if (!ratedW) reasons.push('Missing snapshot pricing panel power');
  if (!referenceDcKwh) reasons.push('Missing/incomplete snapshot panel DC production');
  if (!inverterType) reasons.push('Unknown/ambiguous selected inverter type');
  if (!inverterCount) reasons.push('Invalid/missing inverter count');
  if (!inverterW) reasons.push('Missing inverter AC power');
  if (!efficiency) reasons.push('Missing inverter efficiency');
  if (!['2', '3'].includes(engine)) reasons.push('Unsupported snapshot production engine');
  if (!noDiurnalCurves) reasons.push('Diurnal clipping curves require another calculation');
  if (ratio !== null && factor === null) reasons.push('DC/AC ratio outside supported factor table');
  if (!annualConsumption) reasons.push('Missing snapshot annual consumption');
  if (projectPanelCount && activePanelCount !== projectPanelCount)
    reasons.push('Stored snapshot count differs from panel array; using active array');
  const catalogFallback = (!pricingInverterW && inverterW) || (!pricingEfficiency && efficiency);
  if (catalogFallback) reasons.push('Inverter power/efficiency uses selected-model catalog fallback');
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
    snapshotDate: source.snapshotDate ? new Date(source.snapshotDate) : '',
    snapshotVersionId: source.snapshotVersionId,
    snapshotEngineVersion: engine,
    energyCalculationStatus: reasons.length ? reasons.join('; ') : 'Calculated from latest saved snapshot',
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
    values.snapshotDate, values.snapshotVersionId, values.snapshotEngineVersion,
    values.energyCalculationStatus,
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
              snapshotDate: get('snapshot_date'),
              snapshotVersionId: get('snapshot_version_id'),
              panelsMissingProduction: get('panels_missing_production'),
            }));
          });
        } catch (error) {
          console.error(`[PROJECT ENERGY ERROR] ${source.label}: ${error}`);
          // A failed GoodLeap lookup is not evidence that the project is absent.
          batch.forEach((id) => {
            if (!byProjectId.has(id)) byProjectId.set(id, {
              energyCalculationStatus: `${source.label} snapshot query failed; retry refresh`,
            });
          });
        }
      });
    unresolved = unresolved.filter((id) => !byProjectId.has(id));
  });
  unresolved.forEach((id) => byProjectId.set(id, {
    energyCalculationStatus: 'Project not found in GoodLeap or Sales',
  }));
  return byProjectId;
}

function buildProjectIdSummaryEnergyQuery_(projectIds, projectsTable) {
  const literals = projectIds.map(postHogStringLiteral_).join(', ');
  const pricingTable = projectIdSummaryRelatedTable_(
    projectsTable, 'pricingversions',
  );
  const versionsTable = projectIdSummaryRelatedTable_(
    projectsTable, 'projectversions',
  );
  return [
    'WITH ranked_versions AS (SELECT *,',
    '  row_number() OVER (PARTITION BY project_id, organization_id',
    '    ORDER BY created_at DESC, id DESC) AS version_rank',
    `  FROM ${versionsTable} WHERE project_id IN (${literals})),`,
    'latest_versions AS (SELECT *,',
    "  arrayFilter(x -> JSONExtractBool(x, 'isActive'),",
    "    JSONExtractArrayRaw(ifNull(toString(solar_panels), '[]'))) AS active_panels",
    '  FROM ranked_versions WHERE version_rank = 1)',
    'SELECT p.id AS project_id,',
    '  v.id AS snapshot_version_id, v.created_at AS snapshot_date,',
    '  v.active_panels_count AS project_active_panel_count,',
    '  length(v.active_panels) AS active_panel_count,',
    "  arraySum(arrayMap(x -> JSONExtractFloat(x, 'panelAnnualProdDckwh'),",
    '    v.active_panels)) AS reference_dc_production_kwh,',
    "  arrayCount(x -> JSONExtractRaw(x, 'panelAnnualProdDckwh') IN ('', 'null'),",
    '    v.active_panels) AS panels_missing_production,',
    "  arrayCount(x -> JSONExtractRaw(x, 'diurnalDcShape') NOT IN ('', 'null', '[]'),",
    '    v.active_panels) AS panels_with_diurnal_shape,',
    "  JSONExtractFloat(arrayFirst(x -> JSONExtractString(x, 'id') =",
    '    v.solar_panel_type_id,',
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'solar_panels')),",
    "    'capacity_watts') AS panel_rated_power_w,",
    "  arrayFirst(x -> JSONExtractString(x, 'id') = v.inverter_type_id,",
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'inverters'))",
    '    AS selected_inverter_json,',
    '  v.inverter_model_override, v.inverter_count_override,',
    '  v.annual_energy_use_ackwh, v.production_engine_version',
    `FROM ${projectsTable} AS p`,
    'LEFT ANY JOIN latest_versions AS v ON v.project_id = p.id',
    '  AND v.organization_id = p.organization_id',
    `LEFT ANY JOIN ${pricingTable} AS pv ON pv.id = v.pricing_version_id`,
    `WHERE p.id IN (${literals})`,
    `LIMIT ${Math.max(projectIds.length * 2, projectIds.length)}`,
  ].join('\n');
}

/** Read-only end-to-end validation of the two inspected latest snapshots. */
function validateArtemisSnapshotEnergyExamples() {
  const examples = [
    {id: '1a178bd7-8640-4702-b7b5-c0e929404c06',
      version: '80c4c67b-d2cf-4809-ada2-42df895ec044', count: 20,
      dc: 11473.880950039056, ac: 11995.002859830853, size: 8.6, offset: 142},
    {id: 'f8c08b92-ce68-453b-9353-210e41c2d149',
      version: 'aa604b23-fc06-49c0-a7b7-4ad7323344cf', count: 9,
      dc: 3842.675949950245, ac: 4022.389215636849, size: 3.87, offset: 68},
  ];
  const lookup = fetchProjectIdSummaryEnergyMetrics_(examples.map((item) => item.id));
  const results = examples.map((item) => {
    const metrics = lookup.get(item.id);
    const passed = Boolean(metrics && metrics.snapshotVersionId === item.version &&
      metrics.activePanelCount === item.count &&
      Math.abs(metrics.referenceDcProductionKwh - item.dc) < 0.001 &&
      Math.abs(metrics.estimatedAnnualAcProductionKwh - item.ac) < 0.001 &&
      Math.abs(metrics.systemSizeKw - item.size) < 0.000001 &&
      metrics.estimatedOffsetPercent === item.offset);
    return {projectId: item.id, metrics, passed};
  });
  console.log(JSON.stringify(results, null, 2));
  if (!results.every((item) => item.passed)) throw new Error(
    'Snapshot example validation failed or a newer snapshot is available.');
  return results;
}

/** Read-only PostHog check before publishing the migrated summary. */
function validateArtemisEnergyProjectExample() {
  return validateArtemisSnapshotEnergyExamples();
}

/** Read-only regression validation for both reported count discrepancies. */
function validateArtemisPanelCountRules() {
  return validateArtemisSnapshotEnergyExamples();
}

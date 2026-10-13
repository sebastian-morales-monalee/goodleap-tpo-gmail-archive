/**
 * Artemis V2/V3 energy metrics from current project/pricing and live panel data.
 * The latest saved design supplies panel membership, not historic production.
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

// Warehouse joins/JSON expansion have a stricter runtime budget than map reads.
// Keep energy batches independent of the 100-project metadata batch setting.
const PROJECT_ENERGY_QUERY_BATCH_SIZE = 5;

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

function projectEnergySelectedInverterModel_(rawJson, modelOverride, systemSizeKw) {
  let inverter;
  try {
    inverter = JSON.parse(String(rawJson || '{}'));
  } catch (error) {
    return null;
  }
  if (!inverter || !Array.isArray(inverter.models)) return null;
  const override = String(modelOverride || '').trim().toLowerCase();
  const models = inverter.models;
  let matches;
  let selectionMethod;
  if (override) {
    selectionMethod = 'explicit override';
    matches = models.filter((item) =>
        String(item.id || '').toLowerCase() === override ||
        String(item.model || '').toLowerCase() === override);
  } else if (models.length === 1) {
    selectionMethod = 'single configured model';
    // 0/0 is the microinverter convention, not a zero-size eligibility range.
    const item = models[0];
    const min = item.minSystemSizeKw, max = item.maxSystemSizeKw;
    const bounded = typeof min === 'number' && typeof max === 'number' && max > min;
    matches = bounded && systemSizeKw !== undefined &&
      !(systemSizeKw > min && systemSizeKw <= max) ? [] : models;
  } else {
    selectionMethod = 'unique system-size range';
    matches = models.filter((item) => typeof item.minSystemSizeKw === 'number' &&
      typeof item.maxSystemSizeKw === 'number' && Number.isFinite(systemSizeKw) &&
      systemSizeKw > item.minSystemSizeKw && systemSizeKw <= item.maxSystemSizeKw);
  }
  // Duplicate pricing bands may reference the same physical model. Never
  // collapse candidates with differing powers or efficiencies.
  const distinct = Array.from(new Map(matches.map((item) => [JSON.stringify([
    item.id || '', item.model || '', item.nominalACPowerOutputW,
    item.ratedACPowerW, item.maxEfficiencyPercentage,
  ]), item])).values());
  return distinct.length === 1 ? {inverter, model: distinct[0], selectionMethod} : null;
}

function projectEnergyModelNumber_(value) {
  return String(value || '').trim().replace(/(?:\s*\([\d.,]+\s*[kK]?[wW]\))+\s*$/, '')
    .trim().toUpperCase();
}

function projectEnergyResolveCatalogModel_(selected, catalog) {
  if (!selected) return null;
  const id = String(selected.model.id || '').toLowerCase();
  const power = projectEnergyFinitePositive_(selected.model.nominalACPowerOutputW) ||
    projectEnergyFinitePositive_(selected.model.ratedACPowerW);
  let matches = id ? catalog.filter((model) => String(model.id).toLowerCase() === id) : [];
  if (!matches.length) matches = catalog.filter((model) =>
    projectEnergyModelNumber_(model.model_number) === projectEnergyModelNumber_(selected.model.model));
  if (power) matches = matches.filter((model) =>
    projectEnergyFinitePositive_(model.nominal_ac_power_output_w) === power);
  if (matches.length === 1) return matches[0];
  if (!matches.length) return null;
  const strategies = matches.map((model) =>
    String(model.count_strategy || '').trim().toLowerCase());
  if (!strategies[0] || strategies.some((type) => type !== strategies[0])) return null;
  // Resolve only the agreed type; do not choose arbitrary catalogue metadata.
  return {count_strategy: strategies[0]};
}

function calculateProjectEnergyMetrics_(source) {
  const current = source.dataSource === 'current-project-live-panels';
  if (!current && !source.snapshotVersionId) return {
    energyCalculationStatus: source.errorReason || 'No saved snapshot found',
  };
  const rawPanelCount = projectEnergyFinitePositive_(
    source.activePanelCount,
  );
  const projectPanelCount = projectEnergyFinitePositive_(source.projectActivePanelCount);
  const ratedW = projectEnergyFinitePositive_(source.panelRatedPowerW);
  const activePanelCount = current ? projectPanelCount : rawPanelCount;
  const systemSizeKw = activePanelCount && ratedW ? activePanelCount * ratedW / 1000 : null;
  const selected = projectEnergySelectedInverterModel_(
    source.selectedInverterJson,
    source.inverterModelOverride,
    systemSizeKw,
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
  const hasCountOverride = source.inverterCountOverride !== null &&
    source.inverterCountOverride !== undefined && source.inverterCountOverride !== '';
  const inverterCount = !['micro', 'string'].includes(inverterType) ? null : hasCountOverride
    ? (Number.isInteger(overrideCount) ? overrideCount : null)
    : inverterType === 'micro' ? activePanelCount : 1;
  // Both count and DC now refer to the same active records in one saved version.
  // An inverter override must not change which solar-panel records are summed.
  const panelRecordsMatch = Boolean(activePanelCount &&
    Number(source.panelsMissingProduction || 0) === 0 && (!current ||
      (rawPanelCount === projectPanelCount &&
       Number(source.expectedPanelCount) === projectPanelCount &&
       Number(source.uniquePanelCount) === projectPanelCount)));
  const referenceDcKwh = panelRecordsMatch
    ? projectEnergyFinitePositive_(source.referenceDcProductionKwh) : null;
  const ratio = activePanelCount && ratedW && inverterCount && inverterW
    ? activePanelCount * ratedW / (inverterCount * inverterW)
    : null;
  const factor = ratio === null ? null : projectEnergyCorrectionFactor_(ratio);
  const engine = String(source.productionEngineVersion || '').trim();
  const noDiurnalCurves = Number(source.panelsWithDiurnalShape) === 0;
  const derateValue = source.productionDeratePercent;
  const verifiedZeroDerate = !current || (derateValue !== null && derateValue !== undefined &&
    derateValue !== '' && Number(derateValue) === 0);
  const estimatedAcKwh = ['2', '3'].includes(engine) && noDiurnalCurves &&
      (!current || selected) && verifiedZeroDerate && referenceDcKwh && ratedW && efficiency && factor !== null
    ? referenceDcKwh * (ratedW / 400) * (efficiency / 100) * factor
    : null;
  const annualConsumption = projectEnergyFinitePositive_(
    source.annualEnergyUseAcKwh,
  );
  // annual_energy_use_ackwh already includes the energy-efficiency adjustment.
  const estimatedOffset = estimatedAcKwh !== null && annualConsumption
    ? (current ? estimatedAcKwh / annualConsumption * 100 :
      Math.trunc(estimatedAcKwh / annualConsumption * 100))
    : null;
  const reasons = [];
  if (!activePanelCount) reasons.push('No active panels in project');
  if (!ratedW) reasons.push('Missing selected pricing panel power');
  if (current && !selected) reasons.push('Unknown/ambiguous selected inverter model');
  if (!referenceDcKwh) reasons.push('Missing/incomplete panel DC production');
  if (current && !panelRecordsMatch) reasons.push(
    `Current panel membership mismatch: project=${projectPanelCount || 0}, ` +
    `design=${source.expectedPanelCount || 0}, live=${rawPanelCount || 0}`);
  if (!inverterType) reasons.push('Unknown/ambiguous selected inverter type');
  if (!inverterCount) reasons.push('Invalid/missing inverter count');
  if (!inverterW) reasons.push('Missing inverter AC power');
  if (!efficiency) reasons.push('Missing inverter efficiency');
  if (!['2', '3'].includes(engine)) reasons.push('Unsupported production engine');
  if (!verifiedZeroDerate) reasons.push('Missing/nonzero derate requires canonical engine verification');
  if (!noDiurnalCurves) reasons.push('Diurnal clipping curves require another calculation');
  if (ratio !== null && factor === null) reasons.push('DC/AC ratio outside supported factor table');
  if (!annualConsumption) reasons.push('Missing annual consumption');
  if (!current && projectPanelCount && activePanelCount !== projectPanelCount)
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
    snapshotEngineVersion: current ? String(source.snapshotEngineVersion || '') : engine,
    dataSource: current ? source.dataSource : 'saved-snapshot',
    inverterSelectionMethod: selected && selected.selectionMethod || '',
    projectUpdatedAt: source.projectUpdatedAt || '', panelsUpdatedAt: source.panelsUpdatedAt || '',
    energyCalculationStatus: current
      ? 'Current project/pricing + live panels linked by saved design IDs; ' +
        (reasons.length ? reasons.join('; ') : `Calculated (${selected.selectionMethod})`)
      : reasons.length ? reasons.join('; ') : 'Calculated from latest saved snapshot',
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

function fetchProjectIdSummaryEnergyMetrics_(projectIds, options) {
  const uniqueIds = Array.from(new Set(projectIds.map((id) =>
    String(id || '').trim().toLowerCase()).filter(isProjectIdSummaryUuid_)));
  const settings = getPostHogSolarSettings_();
  const sources = options && options.sources || [
    { table: settings.goodLeapProjectsTable, label: 'GoodLeap' },
    { table: settings.artemisSalesProjectsTable, label: 'Artemis Sales' },
  ];
  const byProjectId = new Map();
  const catalogBySource = options && options.catalogBySource || new Map();
  let unresolved = uniqueIds;
  sources.forEach((source) => {
    if (!unresolved.length) return;
    if (!catalogBySource.has(source.table)) catalogBySource.set(source.table, {
      rows: new Map(), ids: new Set(), names: new Set(),
    });
    const catalogState = catalogBySource.get(source.table);
    chunkPostHogArray_(unresolved, options && options.batchSize || PROJECT_ENERGY_QUERY_BATCH_SIZE)
      .forEach((batch) => {
        try {
          const response = readProjectEnergySourceRows_(
            batch, source.table, `goodleap_apps_script_${source.label.replace(/\s/g, '_')}_energy`,
          );
          const indexes = {};
          response.columns.forEach((column, index) => {
            indexes[String(column).toLowerCase()] = index;
          });
          const selectedModels = response.results.map((row) =>
            projectEnergySelectedInverterModel_(
              row[indexes.selected_inverter_json],
              row[indexes.inverter_model_override],
              Number(row[indexes.project_active_panel_count]) *
                Number(row[indexes.panel_rated_power_w]) / 1000,
            ));
          const modelIds = Array.from(new Set(selectedModels.filter(Boolean)
            .map((selected) => String(selected.model.id || '').toLowerCase())
            .filter(isProjectIdSummaryUuid_)));
          const modelNames = Array.from(new Set(selectedModels.filter(Boolean)
            .map((selected) => projectEnergyModelNumber_(selected.model.model))
            .filter(Boolean)));
          const pendingIds = modelIds.filter((id) => !catalogState.ids.has(id));
          const pendingNames = modelNames.filter((name) => !catalogState.names.has(name));
          if (pendingIds.length || pendingNames.length) {
            const modelTable = projectIdSummaryRelatedTable_(source.table, 'invertermodels');
            const filters = [];
            if (pendingIds.length) filters.push('id IN (' +
              pendingIds.map(postHogStringLiteral_).join(', ') + ')');
            if (pendingNames.length) filters.push('upper(model_number) IN (' +
              pendingNames.map(postHogStringLiteral_).join(', ') + ')');
            const modelResponse = executePostHogHogQL_(
              `SELECT id, model_number, count_strategy, nominal_ac_power_output_w, ` +
              `max_efficiency_percentage FROM ${modelTable} WHERE ` +
              filters.join(' OR ') + ' LIMIT 500',
              'goodleap_apps_script_inverter_count_strategy',
            );
            if (modelResponse.results.length >= 500) {
              throw new Error('Inverter catalogue lookup reached its limit; uniqueness is unknown.');
            }
            modelResponse.results.forEach((row) => {
              const model = Object.fromEntries(modelResponse.columns.map((column, index) => [column, row[index]]));
              catalogState.rows.set(String(model.id).toLowerCase(), model);
            });
            pendingIds.forEach((id) => catalogState.ids.add(id));
            pendingNames.forEach((name) => catalogState.names.add(name));
          }
          const catalog = Array.from(catalogState.rows.values());
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
              dataSource: get('energy_data_source'),
              expectedPanelCount: get('expected_panel_count'),
              uniquePanelCount: get('unique_panel_count'),
              productionDeratePercent: get('production_derate_percentage'),
              snapshotEngineVersion: get('snapshot_engine_version'),
              projectUpdatedAt: get('project_updated_at'),
              panelsUpdatedAt: get('panels_updated_at'),
            }));
          });
        } catch (error) {
          if (batch.length > 1) {
            console.warn(`[PROJECT ENERGY RETRY] ${source.label}: retrying ${batch.length} projects individually.`);
            // Retry the SAME source first. Only a successful empty lookup is
            // evidence that an ID may be looked up in the Sales fallback.
            const retry = fetchProjectIdSummaryEnergyMetrics_(batch, {
              sources: [source], batchSize: 1, allowQueryErrors: true, catalogBySource,
            });
            retry.forEach((metrics, id) => {
              if (metrics.energyCalculationStatus !== 'Project not found in GoodLeap or Sales')
                byProjectId.set(id, metrics);
            });
            return;
          }
          console.error(`[PROJECT ENERGY ERROR] ${source.label}: ${error}`);
          // A failed GoodLeap lookup is not evidence that the project is absent.
          batch.forEach((id) => {
            if (!byProjectId.has(id)) byProjectId.set(id, {
              energyCalculationStatus: `${source.label} current energy query failed; retry refresh`,
            });
          });
        }
      });
    unresolved = unresolved.filter((id) => !byProjectId.has(id));
  });
  unresolved.forEach((id) => byProjectId.set(id, {
    energyCalculationStatus: 'Project not found in GoodLeap or Sales',
  }));
  const failedIds = Array.from(byProjectId).filter(([id, metrics]) =>
    /current energy query failed/.test(metrics.energyCalculationStatus || '')).map(([id]) => id);
  if (failedIds.length && !(options && options.allowQueryErrors)) throw new Error(
    `Energy refresh aborted: source query failed for ${failedIds.length} project(s). ` +
    'Do not publish incomplete results; retry refresh.');
  return byProjectId;
}

function buildProjectIdSummaryEnergyQuery_(projectIds, projectsTable) {
  const literals = projectIds.map(postHogStringLiteral_).join(', ');
  const pricingTable = projectIdSummaryRelatedTable_(
    projectsTable, 'pricingversions',
  );
  const organizationsTable = projectIdSummaryRelatedTable_(projectsTable, 'organizations');
  return [
    'SELECT p.id AS project_id, p.organization_id,',
    "  'current-project-live-panels' AS energy_data_source,",
    '  p.updated_at AS project_updated_at,',
    '  p.active_panels_count AS project_active_panel_count,',
    "  if(arrayCount(x -> JSONExtractString(x, 'id') = p.solar_panel_type_id,",
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'solar_panels')) = 1,",
    "    JSONExtractFloat(arrayFirst(x -> JSONExtractString(x, 'id') =",
    '    p.solar_panel_type_id,',
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'solar_panels')),",
    "    'capacity_watts'), NULL) AS panel_rated_power_w,",
    "  if(arrayCount(x -> JSONExtractString(x, 'id') = p.inverter_type_id,",
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'inverters')) = 1,",
    "    arrayFirst(x -> JSONExtractString(x, 'id') = p.inverter_type_id,",
    "    JSONExtractArrayRaw(coalesce(pv.value, '{}'), 'inverters')), '{}')",
    '    AS selected_inverter_json,',
    '  p.inverter_model_override, p.inverter_count_override, p.annual_energy_use_ackwh,',
    '  coalesce(p.production_engine_version,',
    "    JSONExtractString(coalesce(o.settings, '{}'), 'defaultProductionEngineVersion'))",
    '    AS production_engine_version,',
    '  coalesce(p.production_derate_percentage,',
    "    if(JSONExtractRaw(coalesce(o.settings, '{}'), 'defaultProductionDeratePercentage')",
    "      IN ('', 'null'), NULL, JSONExtractFloat(coalesce(o.settings, '{}'),",
    "      'defaultProductionDeratePercentage'))) AS production_derate_percentage",
    `FROM ${projectsTable} AS p`,
    `LEFT ANY JOIN ${pricingTable} AS pv ON pv.id = p.pricing_version_id`,
    '  AND pv.organization_id = p.organization_id',
    `LEFT ANY JOIN ${organizationsTable} AS o ON o.id = p.organization_id`,
    `WHERE p.id IN (${literals})`,
    `LIMIT ${Math.max(projectIds.length * 2, projectIds.length)}`,
  ].join('\n');
}

function buildProjectEnergyMembershipQuery_(projectIds, projectsTable, organizationIds) {
  const table = projectIdSummaryRelatedTable_(projectsTable, 'projectversions');
  return [
    'SELECT project_id, organization_id,',
    '  tupleElement(latest, 1) AS snapshot_version_id,',
    '  tupleElement(latest, 2) AS snapshot_date,',
    '  tupleElement(latest, 3) AS snapshot_engine_version,',
    "  arrayMap(x -> JSONExtractString(x, 'id'),",
    "    arrayFilter(x -> JSONExtractBool(x, 'isActive'),",
    "    JSONExtractArrayRaw(ifNull(toString(tupleElement(latest, 4)), '[]')))) AS active_panel_ids",
    'FROM (SELECT project_id, organization_id,',
    '  argMax(tuple(id, created_at, production_engine_version, solar_panels),',
    '    tuple(created_at, id)) AS latest',
    `  FROM ${table} WHERE project_id IN (${projectIds.map(postHogStringLiteral_).join(', ')})`,
    `  AND organization_id IN (${organizationIds.map(postHogStringLiteral_).join(', ')})`,
    '  GROUP BY project_id, organization_id)',
    `LIMIT ${projectIds.length * 2 + 1}`,
  ].join('\n');
}

function buildProjectEnergyLivePanelsQuery_(projectIds, projectsTable, organizationIds, panelIds) {
  const table = projectIdSummaryRelatedTable_(projectsTable, 'solarpanels');
  return [
    'SELECT id, project_id, organization_id, is_active, panel_annual_prod_dckwh,',
    '  diurnal_dc_shape, updated_at',
    `FROM ${table} WHERE project_id IN (${projectIds.map(postHogStringLiteral_).join(', ')})`,
    `AND organization_id IN (${organizationIds.map(postHogStringLiteral_).join(', ')})`,
    `AND id IN (${panelIds.map(postHogStringLiteral_).join(', ')})`,
    `LIMIT ${panelIds.length * 2 + 1}`,
  ].join('\n');
}

function projectEnergyResponseObjects_(response) {
  return response.results.map((row) => Object.fromEntries(response.columns.map((column, index) =>
    [String(column).toLowerCase(), row[index]])));
}

/** Bounded reads avoid repeated warehouse joins and perform exact key matching locally. */
function readProjectEnergySourceRows_(projectIds, projectsTable, queryName) {
  const response = executePostHogHogQL_(
    buildProjectIdSummaryEnergyQuery_(projectIds, projectsTable), queryName + '_project_pricing');
  const projects = projectEnergyResponseObjects_(response);
  if (!projects.length) return response;
  const ids = Array.from(new Set(projects.map((p) => String(p.project_id).toLowerCase())));
  if (ids.length !== projects.length) throw new Error('Duplicate current project rows; uniqueness is unknown.');
  const orgs = Array.from(new Set(projects.map((p) => String(p.organization_id).toLowerCase())));
  const key = (project, org, panel) => [project, org, panel || ''].map((v) => String(v).toLowerCase()).join('|');
  const versionsResponse = executePostHogHogQL_(
    buildProjectEnergyMembershipQuery_(ids, projectsTable, orgs), queryName + '_membership');
  if (versionsResponse.results.length >= ids.length * 2 + 1)
    throw new Error('Saved membership query reached its limit; completeness is unknown.');
  const versions = new Map();
  projectEnergyResponseObjects_(versionsResponse).forEach((v) => {
    const ids = Array.isArray(v.active_panel_ids) ? v.active_panel_ids : JSON.parse(String(v.active_panel_ids || '[]'));
    if (!Array.isArray(ids)) throw new Error('Saved solar panel membership is not an array.');
    v.activeMembers = ids.map((id) => ({id}));
    versions.set(key(v.project_id, v.organization_id), v);
  });
  const members = projects.map((p) => (versions.get(key(p.project_id, p.organization_id)) || {}).activeMembers || []);
  const panelIds = Array.from(new Set(members.flat().map((p) => String(p.id || '').toLowerCase())
    .filter(isProjectIdSummaryUuid_)));
  const live = new Map();
  if (panelIds.length) {
    const panelsResponse = executePostHogHogQL_(
      buildProjectEnergyLivePanelsQuery_(ids, projectsTable, orgs, panelIds), queryName + '_live_panels');
    if (panelsResponse.results.length >= panelIds.length * 2 + 1)
      throw new Error('Live panel query reached its limit; completeness is unknown.');
    projectEnergyResponseObjects_(panelsResponse).forEach((p) => {
      const k = key(p.project_id, p.organization_id, p.id);
      live.set(k, live.has(k) ? null : p); // Duplicates cannot supply an arbitrary production value.
    });
  }
  const enriched = projects.map((p, index) => {
    const v = versions.get(key(p.project_id, p.organization_id)) || {};
    let count = 0, dc = 0, missing = 0, shapes = 0, panelsUpdatedAt = '';
    members[index].forEach((member) => {
      const panel = live.get(key(p.project_id, p.organization_id, member.id));
      if (!panel) {missing++; return;}
      const active = panel.is_active === true || panel.is_active === 1;
      const prod = panel.panel_annual_prod_dckwh;
      const validDc = prod !== null && prod !== undefined && prod !== '' &&
        Number.isFinite(Number(prod)) && Number(prod) >= 0;
      if (!validDc) missing++;
      if (active) {
        count++;
        if (validDc) dc += Number(prod);
        if (!['', 'null', '[]'].includes(String(panel.diurnal_dc_shape || ''))) shapes++;
      }
      if (panel.updated_at && (!panelsUpdatedAt ||
          new Date(panel.updated_at).getTime() > new Date(panelsUpdatedAt).getTime())) panelsUpdatedAt = panel.updated_at;
    });
    return {...p, snapshot_version_id: v.snapshot_version_id, snapshot_date: v.snapshot_date,
      snapshot_engine_version: v.snapshot_engine_version, expected_panel_count: members[index].length,
      unique_panel_count: new Set(members[index].map((m) => String(m.id || '').toLowerCase())
        .filter(isProjectIdSummaryUuid_)).size,
      active_panel_count: count, reference_dc_production_kwh: dc,
      panels_missing_production: missing, panels_with_diurnal_shape: shapes, panels_updated_at: panelsUpdatedAt};
  });
  const columns = Object.keys(enriched[0]);
  return {columns, results: enriched.map((row) => columns.map((column) => row[column]))};
}

/** Read-only current-source pilot, including Sales fallback: no sheet writes. */
function validateCurrentProjectEnergyExamples() {
  const ids = [
    'd2d4ad7b-0b27-4dbc-a315-86511e7f0835',
    'ad680382-2900-4f0b-86c3-0f119787e119',
    '33c9f239-60f5-4129-bc58-a8aa93ff35ee',
    'd5e7dd16-f080-4afd-adba-42b6e729f70d',
    'b0035674-41ef-456e-a6c5-afbe042bd82b',
    'b5c78589-72a2-4930-8141-3b1fd33225c3',
    '5a425393-3ce3-480a-a921-24a981ad2045',
    '1a178bd7-8640-4702-b7b5-c0e929404c06',
    '492ee428-cc2e-45fd-8d6d-005d7c5a760f',
  ];
  const lookup = fetchProjectIdSummaryEnergyMetrics_(ids);
  const results = ids.map((id) => ({projectId: id, metrics: lookup.get(id)}));
  results.forEach((row) => console.log(JSON.stringify({
    projectId: row.projectId, dataSource: row.metrics && row.metrics.dataSource,
    activePanelCount: row.metrics && row.metrics.activePanelCount,
    systemSizeKw: row.metrics && row.metrics.systemSizeKw,
    inverterType: row.metrics && row.metrics.inverterType,
    inverterNominalAcPowerW: row.metrics && row.metrics.inverterNominalAcPowerW,
    inverterCount: row.metrics && row.metrics.inverterCount,
    dcAcRatio: row.metrics && row.metrics.dcAcRatio,
    estimatedAnnualAcProductionKwh: row.metrics && row.metrics.estimatedAnnualAcProductionKwh,
    estimatedOffsetPercent: row.metrics && row.metrics.estimatedOffsetPercent,
    energyCalculationStatus: row.metrics && row.metrics.energyCalculationStatus,
  })));
  if (results.some((row) => !row.metrics || row.metrics.dataSource !== 'current-project-live-panels'))
    throw new Error('Current-source pilot lookup failed; do not publish a refresh.');
  const example = results[0].metrics;
  if (example.activePanelCount !== 11 || example.systemSizeKw !== 4.73 ||
      example.inverterNominalAcPowerW !== 3800 ||
      Math.abs(example.estimatedAnnualAcProductionKwh - 4794.004571914672) > 0.001 ||
      example.estimatedAnnualAcProductionKwh === null)
    throw new Error('Verified pilot changed or failed; inspect before publishing.');
  return results;
}

/** Legacy name retained as a current-source validation alias. */
function validateArtemisSnapshotEnergyExamples() {
  return validateCurrentProjectEnergyExamples();
}

/** Read-only PostHog check before publishing the migrated summary. */
function validateArtemisEnergyProjectExample() {
  return validateArtemisSnapshotEnergyExamples();
}

/** Read-only regression validation for both reported count discrepancies. */
function validateArtemisPanelCountRules() {
  return validateArtemisSnapshotEnergyExamples();
}

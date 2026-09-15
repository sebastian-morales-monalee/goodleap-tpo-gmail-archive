/**
 * GoodLeap TPO - Production-only Shade Reports comparison view
 *
 * This file belongs in the SAME Apps Script project as
 * TOFValuesComparison.gs and ProjectIdSummary.gs. It maintains a filtered,
 * materialized copy of Shade Reports Comparison for Project IDs whose
 * Production Category Group is "Production with other categories".
 *
 * It never reads source CSVs and never calls OpenAI, PostHog, Gmail, or Drive.
 */

const SHADE_REPORTS_PROD_CONFIG = {
  SHEET_NAME: 'Shade Reports Comparison PROD',
  SOURCE_SHEET_NAME: 'Shade Reports Comparison',
  PROJECT_SUMMARY_SHEET_NAME: 'Project ID Summary',
  CATEGORY_HEADER: 'Production Category Group',
  PRODUCTION_GROUP_LABEL: 'Production with other categories',
  MAX_OUTPUT_ROWS: 50000,
  PREVIEW_MISSING_LIMIT: 20,
};

/** Creates or upgrades the managed PROD view and immediately populates it. */
function setupShadeReportsComparisonProd() {
  const result = refreshShadeReportsComparisonProd();
  console.log(`${SHADE_REPORTS_PROD_CONFIG.SHEET_NAME} setup completed.`);
  return result;
}

/**
 * Shows the eligible, included, and missing Project ID counts without writing.
 */
function previewShadeReportsComparisonProd() {
  const resources = getOrCreateResources_();
  const view = buildShadeReportsComparisonProdView_(resources.spreadsheet);
  const result = buildShadeReportsComparisonProdStats_(view);
  result.missingProjectIds = view.missingProjectIds.slice(
    0,
    SHADE_REPORTS_PROD_CONFIG.PREVIEW_MISSING_LIMIT,
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `Preview completed without writing ${SHADE_REPORTS_PROD_CONFIG.SHEET_NAME}.`,
  );
  return result;
}

/** Rebuilds the production-only view when its filtered source changed. */
function refreshShadeReportsComparisonProd() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. The PROD comparison refresh ' +
      'was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    const resources = getOrCreateResources_();
    const result = refreshShadeReportsComparisonProdForSpreadsheet_(
      resources.spreadsheet,
    );
    SpreadsheetApp.flush();
    console.log(JSON.stringify(result, null, 2));
    console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Best-effort entry point used while another workflow owns the script lock. */
function refreshShadeReportsComparisonProdSafely_(spreadsheet) {
  try {
    return refreshShadeReportsComparisonProdForSpreadsheet_(spreadsheet);
  } catch (error) {
    const message = String(error).slice(0, 1000);
    console.error(
      `${SHADE_REPORTS_PROD_CONFIG.SHEET_NAME} refresh failed safely: ` +
      message,
    );
    return {updated: false, error: message};
  }
}

function refreshShadeReportsComparisonProdForSpreadsheet_(spreadsheet) {
  assertShadeReportsComparisonProdDependencies_();
  const view = buildShadeReportsComparisonProdView_(spreadsheet);
  const sheet = getOrCreateShadeReportsComparisonProdSheet_(spreadsheet);
  const existingRows = loadShadeReportsComparisonProdRows_(sheet);
  const unchanged = shadeReportsComparisonProdRowsEqual_(
    existingRows,
    view.rows,
  );

  if (!unchanged) {
    rewriteTOFValuesComparisonRows_(sheet, view.rows);
  }

  const result = buildShadeReportsComparisonProdStats_(view);
  result.sheet = SHADE_REPORTS_PROD_CONFIG.SHEET_NAME;
  result.updated = !unchanged;
  result.unchanged = unchanged;
  return result;
}

function buildShadeReportsComparisonProdView_(spreadsheet) {
  assertShadeReportsComparisonProdDependencies_();
  const eligibleProjectIds = loadShadeReportsComparisonProdEligibleIds_(
    spreadsheet,
  );
  const source = loadShadeReportsComparisonProdSource_(spreadsheet);
  const includedProjectIds = new Set();
  const rows = source.rows.filter((row) => {
    const key = String(row[0] || '').trim().toLowerCase();
    if (!key || !eligibleProjectIds.has(key)) return false;
    includedProjectIds.add(key);
    return true;
  });

  if (rows.length > SHADE_REPORTS_PROD_CONFIG.MAX_OUTPUT_ROWS) {
    throw new Error(
      `${SHADE_REPORTS_PROD_CONFIG.SHEET_NAME} would contain ${rows.length} ` +
      'rows, exceeding the safety limit of ' +
      `${SHADE_REPORTS_PROD_CONFIG.MAX_OUTPUT_ROWS}.`,
    );
  }

  const missingProjectIds = Array.from(eligibleProjectIds)
    .filter((projectId) => !includedProjectIds.has(projectId))
    .sort();
  return {
    rows,
    sourceRows: source.rows.length,
    sourceProjectIds: source.projectIds,
    eligibleProjectIds,
    includedProjectIds,
    missingProjectIds,
  };
}

function loadShadeReportsComparisonProdEligibleIds_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    SHADE_REPORTS_PROD_CONFIG.PROJECT_SUMMARY_SHEET_NAME,
  );
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error(
      'Project ID Summary is missing or empty. Run setupProjectIdSummary() ' +
      'first.',
    );
  }
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireShadeReportsComparisonProdHeader_(
    headers,
    'Project ID',
    sheet.getName(),
  );
  const categoryIndex = requireShadeReportsComparisonProdHeader_(
    headers,
    SHADE_REPORTS_PROD_CONFIG.CATEGORY_HEADER,
    sheet.getName(),
  );
  const expectedCategory = SHADE_REPORTS_PROD_CONFIG.PRODUCTION_GROUP_LABEL
    .toLowerCase();
  const projectIds = new Set();
  values.slice(1).forEach((row) => {
    const category = String(row[categoryIndex] || '').trim().toLowerCase();
    if (category !== expectedCategory) return;
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (projectId) projectIds.add(projectId);
  });
  return projectIds;
}

function loadShadeReportsComparisonProdSource_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    SHADE_REPORTS_PROD_CONFIG.SOURCE_SHEET_NAME,
  );
  if (!sheet) {
    throw new Error(
      `${SHADE_REPORTS_PROD_CONFIG.SOURCE_SHEET_NAME} is missing. ` +
      'Run setupTOFValuesComparison() first.',
    );
  }
  const headers = getTOFValuesComparisonHeaders_();
  if (sheet.getLastRow() < 1) {
    throw new Error(
      `${SHADE_REPORTS_PROD_CONFIG.SOURCE_SHEET_NAME} is empty.`,
    );
  }
  const actualHeaders = sheet
    .getRange(1, 1, 1, headers.length)
    .getDisplayValues()[0]
    .map((value) => String(value).trim());
  if (!TOFComparisonArraysEqual_(actualHeaders, headers)) {
    throw new Error(
      `${SHADE_REPORTS_PROD_CONFIG.SOURCE_SHEET_NAME} has an unexpected ` +
      'schema. Run setupTOFValuesComparison() before refreshing the PROD view.',
    );
  }
  const rows = sheet.getLastRow() > 1
    ? sheet
        .getRange(2, 1, sheet.getLastRow() - 1, headers.length)
        .getValues()
    : [];
  const projectIds = new Set(
    rows
      .map((row) => String(row[0] || '').trim().toLowerCase())
      .filter(Boolean),
  );
  return {rows, projectIds};
}

function getOrCreateShadeReportsComparisonProdSheet_(spreadsheet) {
  const headers = getTOFValuesComparisonHeaders_();
  let sheet = spreadsheet.getSheetByName(
    SHADE_REPORTS_PROD_CONFIG.SHEET_NAME,
  );
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHADE_REPORTS_PROD_CONFIG.SHEET_NAME);
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      headers.length - sheet.getMaxColumns(),
    );
  }
  const currentHeaders = sheet.getLastRow() > 0
    ? sheet
        .getRange(1, 1, 1, headers.length)
        .getDisplayValues()[0]
        .map((value) => String(value).trim())
    : [];
  const populated = currentHeaders.some(Boolean);
  if (populated && !TOFComparisonArraysEqual_(currentHeaders, headers)) {
    throw new Error(
      `${SHADE_REPORTS_PROD_CONFIG.SHEET_NAME} already exists with an ` +
      'unexpected schema. Preserve and review it before rerunning setup.',
    );
  }
  if (!populated) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    formatTOFValuesComparisonSheet_(sheet, 1);
  }
  return sheet;
}

function loadShadeReportsComparisonProdRows_(sheet) {
  const headers = getTOFValuesComparisonHeaders_();
  if (sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, headers.length)
    .getValues();
}

function buildShadeReportsComparisonProdStats_(view) {
  return {
    sourceSheet: SHADE_REPORTS_PROD_CONFIG.SOURCE_SHEET_NAME,
    sourceRows: view.sourceRows,
    sourceProjects: view.sourceProjectIds.size,
    eligibleProductionProjects: view.eligibleProjectIds.size,
    includedProjects: view.includedProjectIds.size,
    excludedSourceProjects:
      view.sourceProjectIds.size - view.includedProjectIds.size,
    missingComparisonProjects: view.missingProjectIds.length,
    outputRows: view.rows.length,
  };
}

function shadeReportsComparisonProdRowsEqual_(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  const headers = getTOFValuesComparisonHeaders_();
  for (let rowIndex = 0; rowIndex < leftRows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      if (
        normalizeShadeReportsComparisonProdValue_(
          leftRows[rowIndex][columnIndex],
        ) !== normalizeShadeReportsComparisonProdValue_(
          rightRows[rowIndex][columnIndex],
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

function normalizeShadeReportsComparisonProdValue_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `date:${value.getTime()}`;
  }
  return `${typeof value}:${String(value == null ? '' : value)}`;
}

function requireShadeReportsComparisonProdHeader_(headers, name, sheetName) {
  const index = headers.indexOf(name);
  if (index < 0) {
    throw new Error(`Missing header "${name}" in ${sheetName}.`);
  }
  return index;
}

function assertShadeReportsComparisonProdDependencies_() {
  const requiredFunctions = [
    ['getTOFValuesComparisonHeaders_', typeof getTOFValuesComparisonHeaders_],
    ['TOFComparisonArraysEqual_', typeof TOFComparisonArraysEqual_],
    ['rewriteTOFValuesComparisonRows_', typeof rewriteTOFValuesComparisonRows_],
    ['formatTOFValuesComparisonSheet_', typeof formatTOFValuesComparisonSheet_],
  ];
  const missing = requiredFunctions
    .filter((entry) => entry[1] !== 'function')
    .map((entry) => entry[0]);
  if (missing.length > 0) {
    throw new Error(
      `Missing TOF comparison dependencies: ${missing.join(', ')}. ` +
      'Install the repository version of TOFValuesComparison.gs.',
    );
  }
}

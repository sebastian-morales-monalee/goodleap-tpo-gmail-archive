/**
 * GoodLeap TPO - Aurora PDF versus Artemis project solar comparison
 *
 * This file belongs in the SAME Apps Script project as the other workflow
 * files. It reads the four structured CSV links already stored in
 * "PDF Analysis" and maintains one deterministic comparison per Project ID
 * in "Shade Reports Comparison". OpenAI is not called by this workflow.
 *
 * Safe first-run sequence:
 *   1) previewTOFValuesComparison()
 *   2) setupTOFValuesComparison()
 *   3) syncPendingTOFValuesComparisons()
 *
 * Rerun the pending sync until pendingProjects is zero. Existing projects are
 * checked in small rotating batches by the automatic workflow, so a changed
 * CSV is eventually recalculated without making the hourly job unbounded.
 */

const TOF_COMPARISON_CONFIG = {
  SHEET_NAME: 'Shade Reports Comparison',
  LEGACY_SHEET_NAME: 'TOF Values Comparison',
  SOURCE_SHEET_NAME: 'PDF Analysis',
  PROJECTS_SHEET_NAME: 'PostHog Projects',
  HEADER_BACKGROUND: '#7200c9',
  HEADER_FONT_COLOR: '#ffffff',
  TAB_COLOR: '#7200c9',
  BODY_FONT_FAMILY: 'Arial',
  BODY_FONT_COLOR: '#202124',
  PROJECT_BAND_PRIMARY: '#ffffff',
  PROJECT_BAND_SECONDARY: '#f3f6fa',
  PROJECT_BORDER_COLOR: '#9aa0a6',
  AURORA_HEADER_BACKGROUND: '#1f4e78',
  AURORA_DATA_BACKGROUND: '#eaf2f8',
  ARTEMIS_HEADER_BACKGROUND: '#2e7d32',
  ARTEMIS_DATA_BACKGROUND: '#eaf4ea',
  DELTA_HEADER_BACKGROUND: '#b45f06',
  DELTA_DATA_BACKGROUND: '#fff2cc',
  SUPPORT_HEADER_BACKGROUND: '#4b5563',
  ERROR_HEADER_BACKGROUND: '#9c1c1c',
  DATE_FORMAT: 'yyyy-mm-dd hh:mm:ss',
  ALGORITHM_VERSION: 'tof-comparison-v5-all-source-geometry-averages',
  MANUAL_BATCH_SIZE: 10,
  AUTOMATIC_BATCH_SIZE: 5,
  AUTOMATIC_EXISTING_SCAN_SIZE: 3,
  PREVIEW_LIMIT: 3,
  MAX_SOURCE_ROWS: 100,
  MAX_OUTPUT_ROWS: 50000,
  EXACT_ANGLE_TOLERANCE: 0.05,
  EXACT_PITCH_TOLERANCE: 0.05,
  MAX_PANEL_DIFFERENCE: 2,
  MAX_PANEL_PERCENT_DIFFERENCE: 0.15,
  MAX_AZIMUTH_DIFFERENCE: 3,
  MAX_PITCH_DIFFERENCE: 5,
  PANEL_PRIORITY_WEIGHT: 1000000000,
  MISSING_PANEL_COST: 1000000000000,
  INELIGIBLE_COST: 8000000000000000,
  SCAN_CURSOR_PROPERTY: 'TOF_VALUES_COMPARISON_SCAN_CURSOR',
};

const TOF_COMPARISON_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const TOF_COMPARISON_REQUIRED_SOURCE_HEADERS = [
  'Source Drive File ID',
  'Project ID',
  'Source Received At',
  'Analyzed At',
  'PDF Summary CSV URL',
  'PDF Monthly CSV URL',
  'Project Summary CSV URL',
  'Project Monthly CSV URL',
  'Project Data Status',
  'Human Review Required',
];

// Version 2 changes reader-facing terminology without moving any columns.
// setupTOFValuesComparison() recognizes the version 1 row and renames it in
// place, preserving existing data until each Project ID is recalculated.
const TOF_COMPARISON_LEGACY_HEADER_BY_CURRENT = {
  'Aurora Summary CSV URL': 'PDF Summary CSV URL',
  'Artemis Summary CSV URL': 'Project Summary CSV URL',
  'Aurora Monthly CSV URL': 'PDF Monthly CSV URL',
  'Artemis Monthly CSV URL': 'Project Monthly CSV URL',
  'Aurora Array ID': 'PDF Array ID',
  'Artemis Array ID(s)': 'Project Array ID(s)',
  'Aurora Panel Count': 'PDF Panel Count',
  'Artemis Panel Count': 'Project Panel Count',
  'Aurora Azimuth': 'PDF Azimuth',
  'Artemis Azimuth': 'Project Azimuth',
  'Aurora Pitch': 'PDF Pitch',
  'Artemis Pitch': 'Project Pitch',
  'Aurora Annual TOF': 'PDF Annual TOF',
  'Artemis Annual TOF': 'Project Annual TOF',
  'Aurora Annual Solar Access': 'PDF Annual Solar Access',
  'Artemis Annual Solar Access': 'Project Annual Solar Access',
  'Aurora Annual TSRF': 'PDF Annual TSRF',
  'Artemis Annual TSRF': 'Project Annual TSRF',
};

/** Creates the managed sheet without processing historical CSVs. */
function setupTOFValuesComparison() {
  const resources = getOrCreateResources_();
  const sheet = getOrCreateTOFValuesComparisonSheet_(resources.spreadsheet);
  console.log(`${TOF_COMPARISON_CONFIG.SHEET_NAME} setup completed.`);
  console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Derived sheet: ${sheet.getName()}`);
  return {sheet: sheet.getName(), headers: getTOFValuesComparisonHeaders_().length};
}

/** Reapplies the managed visual style without rereading CSVs or recalculating data. */
function refreshTOFValuesComparisonFormatting() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. TOF formatting was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    const resources = getOrCreateResources_();
    const sheet = getOrCreateTOFValuesComparisonSheet_(resources.spreadsheet);
    const lastRow = Math.max(sheet.getLastRow(), 1);
    const projectGroups = formatTOFValuesComparisonSheet_(sheet, lastRow);
    SpreadsheetApp.flush();
    const result = {
      sheet: sheet.getName(),
      formattedRows: Math.max(lastRow - 1, 0),
      projectGroups,
    };
    console.log(JSON.stringify(result, null, 2));
    console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Builds a small comparison preview without creating a sheet or writing CSVs.
 */
function previewTOFValuesComparison() {
  const resources = getOrCreateResources_();
  const candidates = loadTOFComparisonCandidates_(resources.spreadsheet)
    .slice(0, TOF_COMPARISON_CONFIG.PREVIEW_LIMIT);
  const preview = candidates.map((candidate) => {
    try {
      const result = buildTOFComparisonForCandidate_(candidate);
      return {
        projectId: candidate.projectId,
        sourceDriveFileId: candidate.sourceDriveFileId,
        comparisonStatus: result.status,
        outputRows: result.rows.length,
        matchedArrays: result.stats.matchedArrays,
        unmatchedAuroraArrays: result.stats.unmatchedAuroraArrays,
        unmatchedArtemisArrays: result.stats.unmatchedArtemisArrays,
        reviewRequired: result.stats.reviewRequired,
      };
    } catch (error) {
      return {
        projectId: candidate.projectId,
        sourceDriveFileId: candidate.sourceDriveFileId,
        error: truncateTOFComparisonText_(String(error), 1000),
      };
    }
  });
  const result = {candidates: candidates.length, preview};
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `Preview completed without writing ${TOF_COMPARISON_CONFIG.SHEET_NAME}.`,
  );
  return result;
}

/** Processes a bounded historical batch of new or newly sourced projects. */
function syncPendingTOFValuesComparisons() {
  return runLockedTOFValuesComparisonSync_({
    batchSize: TOF_COMPARISON_CONFIG.MANUAL_BATCH_SIZE,
    scanExisting: false,
    existingScanSize: 0,
    retryErrors: true,
  });
}

/**
 * Rechecks a bounded rotating batch of existing projects by content hash.
 * This is useful after correcting or replacing an existing source CSV.
 */
function refreshChangedTOFValuesComparisons() {
  return runLockedTOFValuesComparisonSync_({
    batchSize: TOF_COMPARISON_CONFIG.MANUAL_BATCH_SIZE,
    scanExisting: true,
    existingScanSize: TOF_COMPARISON_CONFIG.MANUAL_BATCH_SIZE,
    retryErrors: true,
  });
}

function runLockedTOFValuesComparisonSync_(options) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. TOF comparison was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    const resources = getOrCreateResources_();
    const result = syncTOFValuesComparisonsForSpreadsheet_(
      resources.spreadsheet,
      options,
    );
    SpreadsheetApp.flush();
    console.log(JSON.stringify(result, null, 2));
    console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Best-effort entry point used while another workflow already owns the lock. */
function syncTOFValuesComparisonsSafely_(spreadsheet) {
  try {
    return syncTOFValuesComparisonsForSpreadsheet_(spreadsheet, {
      batchSize: TOF_COMPARISON_CONFIG.AUTOMATIC_BATCH_SIZE,
      scanExisting: true,
      existingScanSize: TOF_COMPARISON_CONFIG.AUTOMATIC_EXISTING_SCAN_SIZE,
      retryErrors: false,
    });
  } catch (error) {
    const message = truncateTOFComparisonText_(String(error), 1000);
    console.error(
      `${TOF_COMPARISON_CONFIG.SHEET_NAME} sync failed safely: ${message}`,
    );
    return {updated: false, error: message};
  }
}

function syncTOFValuesComparisonsForSpreadsheet_(spreadsheet, options) {
  const sheet = getOrCreateTOFValuesComparisonSheet_(spreadsheet);
  const candidates = loadTOFComparisonCandidates_(spreadsheet);
  const existing = loadExistingTOFComparisonState_(sheet);
  const selected = selectTOFComparisonCandidates_(
    candidates,
    existing.byProjectId,
    options || {},
  );
  const updates = new Map();
  const stats = {
    sheet: TOF_COMPARISON_CONFIG.SHEET_NAME,
    candidateProjects: candidates.length,
    sourceIncompleteProjects: candidates.filter(
      (candidate) => !hasAllTOFSourceUrls_(candidate),
    ).length,
    selectedProjects: selected.candidates.length,
    comparedProjects: 0,
    pendingSourceProjects: 0,
    reviewProjects: 0,
    unchangedProjects: 0,
    errorProjects: 0,
    outputRowsWritten: 0,
    pendingProjects: 0,
    updated: false,
  };

  selected.candidates.forEach((candidate) => {
    try {
      const result = buildTOFComparisonForCandidate_(candidate);
      const current = existing.byProjectId.get(candidate.key);
      if (
        current &&
        current.signature === result.signature &&
        current.version === TOF_COMPARISON_CONFIG.ALGORITHM_VERSION
      ) {
        stats.unchangedProjects += 1;
        return;
      }
      updates.set(candidate.key, result.rows);
      stats.outputRowsWritten += result.rows.length;
      if (result.status === 'Pending Sources') {
        stats.pendingSourceProjects += 1;
      } else if (result.status === 'Review Required') {
        stats.reviewProjects += 1;
      } else {
        stats.comparedProjects += 1;
      }
    } catch (error) {
      const message = truncateTOFComparisonText_(String(error), 3000);
      const signature = buildTOFReferenceSignature_(candidate);
      updates.set(candidate.key, [buildTOFStatusRow_(
        candidate,
        'Error',
        'Error',
        message,
        signature,
        message,
      )]);
      stats.outputRowsWritten += 1;
      stats.errorProjects += 1;
      console.error(`[TOF COMPARISON ERROR] ${candidate.projectId} | ${message}`);
    }
  });

  if (updates.size > 0) {
    const rows = existing.rows.filter((row) => {
      const projectId = String(row[0] || '').trim().toLowerCase();
      return !updates.has(projectId);
    });
    updates.forEach((projectRows) => rows.push.apply(rows, projectRows));
    if (rows.length > TOF_COMPARISON_CONFIG.MAX_OUTPUT_ROWS) {
      throw new Error(
        `${TOF_COMPARISON_CONFIG.SHEET_NAME} would contain ${rows.length} ` +
        'rows, exceeding ' +
        `the safety limit of ${TOF_COMPARISON_CONFIG.MAX_OUTPUT_ROWS}.`,
      );
    }
    rows.sort(compareTOFOutputRows_);
    rewriteTOFValuesComparisonRows_(sheet, rows);
    stats.updated = true;
  }

  const finalTracked = new Set(existing.byProjectId.keys());
  updates.forEach((value, key) => finalTracked.add(key));
  stats.pendingProjects = candidates.filter((candidate) => {
    if (!finalTracked.has(candidate.key)) return true;
    const state = existing.byProjectId.get(candidate.key);
    if (updates.has(candidate.key)) {
      const updatedRows = updates.get(candidate.key) || [];
      return updatedRows.length > 0 && updatedRows[0][9] === 'Error';
    }
    return state && (
      isTOFReferenceChanged_(candidate, state) || state.status === 'Error'
    );
  }).length;
  stats.nextExistingScanCursor = selected.nextCursor;
  if (typeof refreshProjectIdSummarySafely_ === 'function') {
    stats.projectIdSummary = refreshProjectIdSummarySafely_(
      spreadsheet,
      {refreshMapData: false},
    );
  } else if (typeof refreshShadeReportsComparisonProdSafely_ === 'function') {
    stats.shadeReportsComparisonProd =
      refreshShadeReportsComparisonProdSafely_(spreadsheet);
  }
  return stats;
}

function loadTOFComparisonCandidates_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(TOF_COMPARISON_CONFIG.SOURCE_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error(
      'PDF Analysis is missing or empty. Complete PDF extraction first.',
    );
  }
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const display = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = display[0].map((value) => String(value).trim());
  TOF_COMPARISON_REQUIRED_SOURCE_HEADERS.forEach((header) =>
    requireTOFComparisonHeader_(headers, header, sheet.getName()),
  );
  const index = {
    sourceFileId: headers.indexOf('Source Drive File ID'),
    projectId: headers.indexOf('Project ID'),
    sourceReceivedAt: headers.indexOf('Source Received At'),
    analyzedAt: headers.indexOf('Analyzed At'),
    pdfSummary: headers.indexOf('PDF Summary CSV URL'),
    pdfMonthly: headers.indexOf('PDF Monthly CSV URL'),
    projectSummary: headers.indexOf('Project Summary CSV URL'),
    projectMonthly: headers.indexOf('Project Monthly CSV URL'),
    projectStatus: headers.indexOf('Project Data Status'),
    humanReview: headers.indexOf('Human Review Required'),
  };
  const projectUrls = loadTOFProjectUrls_(spreadsheet);
  const newestByProject = new Map();

  display.slice(1).forEach((displayRow, offset) => {
    const projectIds = String(displayRow[index.projectId] || '')
      .split(/[\n,;]+/)
      .map((value) => value.trim())
      .filter((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(value),
      );
    if (projectIds.length !== 1) return;
    const projectId = projectIds[0];
    const key = projectId.toLowerCase();
    const rawRow = values[offset + 1];
    const sourceDate = normalizeTOFDate_(
      rawRow[index.sourceReceivedAt] || rawRow[index.analyzedAt],
    );
    const candidate = {
      key,
      projectId,
      projectUrl: projectUrls.get(key) || '',
      sourceDriveFileId: String(displayRow[index.sourceFileId] || '').trim(),
      sourceReceivedAt: sourceDate || '',
      rowNumber: offset + 2,
      pdfSummaryUrl: extractTOFUrl_(displayRow[index.pdfSummary]),
      pdfMonthlyUrl: extractTOFUrl_(displayRow[index.pdfMonthly]),
      projectSummaryUrl: extractTOFUrl_(displayRow[index.projectSummary]),
      projectMonthlyUrl: extractTOFUrl_(displayRow[index.projectMonthly]),
      projectDataStatus: String(displayRow[index.projectStatus] || '').trim(),
      humanReviewRequired: /^(true|yes|1)$/i.test(
        String(displayRow[index.humanReview] || '').trim(),
      ),
    };
    const current = newestByProject.get(key);
    if (!current || compareTOFCandidates_(candidate, current) < 0) {
      newestByProject.set(key, candidate);
    }
  });

  return Array.from(newestByProject.values()).sort(compareTOFCandidates_);
}

function loadTOFProjectUrls_(spreadsheet) {
  const urls = new Map();
  const sheet = spreadsheet.getSheetByName(TOF_COMPARISON_CONFIG.PROJECTS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return urls;
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const idIndex = headers.indexOf('Project ID');
  const urlIndex = headers.indexOf('Project URL');
  if (idIndex < 0 || urlIndex < 0) return urls;
  values.slice(1).forEach((row) => {
    const ids = String(row[idIndex] || '').split(/\n+/).map((value) => value.trim());
    const rowUrls = String(row[urlIndex] || '').split(/\n+/).map((value) => value.trim());
    ids.forEach((id, index) => {
      if (!id) return;
      const key = id.toLowerCase();
      const matching = rowUrls.find((url) => url.toLowerCase().indexOf(key) !== -1);
      if (!urls.has(key)) urls.set(key, matching || rowUrls[index] || '');
    });
  });
  return urls;
}

function compareTOFCandidates_(left, right) {
  const rightTime = right.sourceReceivedAt instanceof Date
    ? right.sourceReceivedAt.getTime() : 0;
  const leftTime = left.sourceReceivedAt instanceof Date
    ? left.sourceReceivedAt.getTime() : 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return right.rowNumber - left.rowNumber;
}

function selectTOFComparisonCandidates_(candidates, existing, options) {
  const batchSize = Math.max(Number(options.batchSize) || 1, 1);
  const priority = candidates.filter((candidate) => {
    const state = existing.get(candidate.key);
    return !state || isTOFReferenceChanged_(candidate, state) ||
      (options.retryErrors && state.status === 'Error');
  });
  const selected = priority.slice(0, batchSize);
  let nextCursor = Number(
    PropertiesService.getScriptProperties().getProperty(
      TOF_COMPARISON_CONFIG.SCAN_CURSOR_PROPERTY,
    ) || 0,
  );

  if (options.scanExisting && selected.length < batchSize) {
    const selectedKeys = new Set(selected.map((candidate) => candidate.key));
    const stable = candidates.filter((candidate) =>
      existing.has(candidate.key) && !selectedKeys.has(candidate.key),
    );
    if (stable.length > 0) {
      const scanSize = Math.min(
        Math.max(Number(options.existingScanSize) || 0, 0),
        batchSize - selected.length,
        stable.length,
      );
      nextCursor = ((nextCursor % stable.length) + stable.length) % stable.length;
      for (let offset = 0; offset < scanSize; offset += 1) {
        selected.push(stable[(nextCursor + offset) % stable.length]);
      }
      nextCursor = (nextCursor + scanSize) % stable.length;
      PropertiesService.getScriptProperties().setProperty(
        TOF_COMPARISON_CONFIG.SCAN_CURSOR_PROPERTY,
        String(nextCursor),
      );
    } else {
      nextCursor = 0;
    }
  }
  return {candidates: selected, nextCursor};
}

function isTOFReferenceChanged_(candidate, state) {
  return String(state.sourceDriveFileId || '') !== candidate.sourceDriveFileId ||
    String(state.pdfSummaryUrl || '') !== candidate.pdfSummaryUrl ||
    String(state.pdfMonthlyUrl || '') !== candidate.pdfMonthlyUrl ||
    String(state.projectSummaryUrl || '') !== candidate.projectSummaryUrl ||
    String(state.projectMonthlyUrl || '') !== candidate.projectMonthlyUrl ||
    String(state.version || '') !== TOF_COMPARISON_CONFIG.ALGORITHM_VERSION;
}

function hasAllTOFSourceUrls_(candidate) {
  return Boolean(
    candidate.pdfSummaryUrl &&
    candidate.pdfMonthlyUrl &&
    candidate.projectSummaryUrl &&
    candidate.projectMonthlyUrl,
  );
}

function buildTOFComparisonForCandidate_(candidate) {
  const missing = [];
  if (!candidate.pdfSummaryUrl) missing.push('Aurora Summary CSV URL');
  if (!candidate.pdfMonthlyUrl) missing.push('Aurora Monthly CSV URL');
  if (!candidate.projectSummaryUrl) missing.push('Artemis Summary CSV URL');
  if (!candidate.projectMonthlyUrl) missing.push('Artemis Monthly CSV URL');
  if (missing.length > 0) {
    const notes = `Missing source: ${missing.join(', ')}.` +
      (candidate.projectDataStatus
        ? ` Project Data Status: ${candidate.projectDataStatus}.`
        : '');
    const signature = buildTOFReferenceSignature_(candidate);
    return {
      status: 'Pending Sources',
      signature,
      rows: [buildTOFStatusRow_(
        candidate,
        'Pending Sources',
        'Pending Sources',
        notes,
        signature,
        '',
      )],
      stats: {
        matchedArrays: 0,
        unmatchedAuroraArrays: 0,
        unmatchedArtemisArrays: 0,
        reviewRequired: true,
      },
    };
  }

  const sources = {
    pdfSummary: readTOFDriveCsv_(candidate.pdfSummaryUrl),
    pdfMonthly: readTOFDriveCsv_(candidate.pdfMonthlyUrl),
    projectSummary: readTOFDriveCsv_(candidate.projectSummaryUrl),
    projectMonthly: readTOFDriveCsv_(candidate.projectMonthlyUrl),
  };
  const signature = hashTOFText_([
    TOF_COMPARISON_CONFIG.ALGORITHM_VERSION,
    sources.pdfSummary.hash,
    sources.pdfMonthly.hash,
    sources.projectSummary.hash,
    sources.projectMonthly.hash,
  ].join('|'));
  const pdf = buildTOFSourceDataset_(
    sources.pdfSummary.text,
    sources.pdfMonthly.text,
    'Aurora',
  );
  const project = buildTOFSourceDataset_(
    sources.projectSummary.text,
    sources.projectMonthly.text,
    'Artemis',
  );
  const groupedProjectRows = groupTOFProjectRows_(project.rows);
  const matching = matchTOFArrays_(pdf.rows, groupedProjectRows.rows);
  const sharedWarnings = []
    .concat(pdf.warnings, project.warnings, groupedProjectRows.warnings);
  if (
    candidate.projectDataStatus &&
    candidate.projectDataStatus !== 'Matched'
  ) {
    sharedWarnings.push(
      `Project Data Status is ${candidate.projectDataStatus}.`,
    );
  }
  if (candidate.humanReviewRequired) {
    sharedWarnings.push(
      'The source Aurora PDF extraction is marked for human review.',
    );
  }
  const rows = [];
  let rowOrder = 1;
  let reviewRequired = sharedWarnings.length > 0;

  matching.matches.forEach((match) => {
    const matchType = classifyTOFMatch_(match);
    const grouped = match.project.members.length > 1;
    const displayedMatchType = grouped
      ? `${matchType} (Grouped Artemis Arrays)`
      : matchType;
    const rowReview = matchType !== 'Exact Panel and Geometry Match' ||
      sharedWarnings.length > 0;
    reviewRequired = reviewRequired || rowReview;
    const matchNotes = buildTOFMatchNotes_(
      match,
      matchType,
      sharedWarnings,
    );
    rows.push(buildTOFComparisonRow_(
      candidate,
      match.pdf,
      match.project,
      rowReview ? 'Review Required' : 'Compared',
      displayedMatchType,
      match.cost,
      matchNotes,
      signature,
      rowOrder,
      '',
    ));
    rowOrder += 1;
  });
  matching.unmatchedPdf.forEach((pdfRow) => {
    reviewRequired = true;
    rows.push(buildTOFComparisonRow_(
      candidate,
      pdfRow,
      null,
      'Review Required',
      'Unmatched Aurora Array',
      '',
      'No eligible Artemis array matched this Aurora array.',
      signature,
      rowOrder,
      '',
    ));
    rowOrder += 1;
  });
  matching.unmatchedProject.forEach((projectRow) => {
    reviewRequired = true;
    rows.push(buildTOFComparisonRow_(
      candidate,
      null,
      projectRow,
      'Review Required',
      'Unmatched Artemis Array',
      '',
      'No eligible Aurora array matched this Artemis array.',
      signature,
      rowOrder,
      '',
    ));
    rowOrder += 1;
  });

  const overallStatus = reviewRequired ? 'Review Required' : 'Compared';
  rows.push(buildTOFComparisonRow_(
    candidate,
    pdf.published,
    project.published,
    overallStatus,
    'Published Weighted Average',
    '',
    'Weighted-average values published in the Aurora and Artemis Summary CSV files.',
    signature,
    rowOrder,
    '',
  ));
  rowOrder += 1;
  const recalculatedRow = buildTOFComparisonRow_(
    candidate,
    calculateTOFWeightedAggregate_(pdf.rows),
    calculateTOFWeightedAggregate_(project.rows),
    overallStatus,
    'Recalculated Weighted Average',
    '',
    'Panel-count-weighted TOF values and arithmetic-mean geometry values recalculated from every original Aurora and Artemis array row.',
    signature,
    rowOrder,
    '',
  );
  applyTOFAverageGeometryValues_(recalculatedRow, pdf.rows, project.rows);
  rows.push(recalculatedRow);

  return {
    status: overallStatus,
    signature,
    rows,
    stats: {
      matchedArrays: matching.matches.length,
      unmatchedAuroraArrays: matching.unmatchedPdf.length,
      unmatchedArtemisArrays: matching.unmatchedProject.length,
      reviewRequired,
    },
  };
}

function buildTOFSourceDataset_(summaryText, monthlyText, label) {
  const summary = parseTOFSummaryCsv_(summaryText, label);
  const monthly = parseTOFMonthlyCsv_(monthlyText, label);
  const warnings = [].concat(summary.warnings, monthly.warnings);
  const summaryIds = new Set(summary.rows.map((row) => row.arrayId));
  summary.rows.forEach((row) => {
    if (monthly.byArrayId.has(row.arrayId)) {
      row.months = monthly.byArrayId.get(row.arrayId).slice();
    } else {
      row.months = Array(12).fill(null);
      warnings.push(`${label} Array ID ${row.arrayId} has no Monthly row.`);
    }
    row.members = [row.arrayId];
  });
  monthly.byArrayId.forEach((value, arrayId) => {
    if (!summaryIds.has(arrayId)) {
      warnings.push(`${label} Monthly Array ID ${arrayId} has no Summary row.`);
    }
  });
  if (summary.rows.length === 0) {
    throw new Error(`${label} Summary CSV contains no array rows.`);
  }
  return {rows: summary.rows, published: summary.published, warnings};
}

function parseTOFSummaryCsv_(text, label) {
  const rows = Utilities.parseCsv(String(text || ''));
  if (rows.length < 2) throw new Error(`${label} Summary CSV is empty.`);
  const headers = rows[0].map(normalizeTOFHeader_);
  const expected = [
    'array id', 'panel count', 'azimuth', 'pitch', 'annual tof',
    'annual solar access', 'annual tsrf',
  ];
  const index = {};
  expected.forEach((header) => {
    const offset = headers.indexOf(header);
    if (offset < 0) throw new Error(`${label} Summary CSV is missing ${header}.`);
    index[header] = offset;
  });
  const output = [];
  const seen = new Set();
  let published = createBlankTOFMetricRow_();
  const warnings = [];
  rows.slice(1).forEach((row) => {
    const arrayId = String(row[index['array id']] || '').trim();
    if (!arrayId) return;
    const metric = {
      arrayId,
      panelCount: parseTOFNumber_(row[index['panel count']], false),
      azimuth: parseTOFNumber_(row[index.azimuth], false),
      pitch: parseTOFNumber_(row[index.pitch], false),
      annualTof: parseTOFNumber_(row[index['annual tof']], true),
      annualSolarAccess: parseTOFNumber_(
        row[index['annual solar access']], true,
      ),
      annualTsrf: parseTOFNumber_(row[index['annual tsrf']], true),
      months: Array(12).fill(null),
      members: [arrayId],
    };
    if (/weighted average/i.test(arrayId)) {
      metric.members = [];
      published = metric;
      return;
    }
    if (seen.has(arrayId)) {
      throw new Error(`${label} Summary CSV repeats Array ID ${arrayId}.`);
    }
    seen.add(arrayId);
    validateTOFMetricRow_(metric, label);
    output.push(metric);
  });
  if (output.length > TOF_COMPARISON_CONFIG.MAX_SOURCE_ROWS) {
    throw new Error(
      `${label} Summary CSV exceeds ${TOF_COMPARISON_CONFIG.MAX_SOURCE_ROWS} arrays.`,
    );
  }
  if (!published.arrayId) {
    warnings.push(`${label} Summary CSV has no published weighted-average row.`);
  }
  return {rows: output, published, warnings};
}

function parseTOFMonthlyCsv_(text, label) {
  const rows = Utilities.parseCsv(String(text || ''));
  if (rows.length < 2) throw new Error(`${label} Monthly CSV is empty.`);
  const headers = rows[0].map(normalizeTOFHeader_);
  const arrayIndex = headers.indexOf('array id');
  if (arrayIndex < 0) throw new Error(`${label} Monthly CSV is missing Array ID.`);
  const monthIndexes = TOF_COMPARISON_MONTHS.map((month) => {
    const offset = headers.indexOf(month.toLowerCase());
    if (offset < 0) throw new Error(`${label} Monthly CSV is missing ${month}.`);
    return offset;
  });
  const byArrayId = new Map();
  rows.slice(1).forEach((row) => {
    const arrayId = String(row[arrayIndex] || '').trim();
    if (!arrayId) return;
    if (byArrayId.has(arrayId)) {
      throw new Error(`${label} Monthly CSV repeats Array ID ${arrayId}.`);
    }
    byArrayId.set(arrayId, monthIndexes.map((offset) =>
      // Both generated Monthly CSV formats already use the 0-100 scale and
      // intentionally omit the percent sign. A legitimate 1 means 1%, not
      // the fractional value 100%.
      parseTOFNumber_(row[offset], false),
    ));
  });
  if (byArrayId.size > TOF_COMPARISON_CONFIG.MAX_SOURCE_ROWS) {
    throw new Error(
      `${label} Monthly CSV exceeds ${TOF_COMPARISON_CONFIG.MAX_SOURCE_ROWS} arrays.`,
    );
  }
  return {byArrayId, warnings: []};
}

function validateTOFMetricRow_(row, label) {
  if (row.panelCount !== null && row.panelCount < 0) {
    throw new Error(`${label} Array ID ${row.arrayId} has negative Panel Count.`);
  }
  ['annualTof', 'annualSolarAccess', 'annualTsrf'].forEach((field) => {
    if (row[field] !== null && (row[field] < 0 || row[field] > 100)) {
      throw new Error(
        `${label} Array ID ${row.arrayId} has ${field} outside 0-100.`,
      );
    }
  });
}

function groupTOFProjectRows_(rows) {
  const buckets = new Map();
  rows.forEach((row) => {
    const match = String(row.arrayId).match(/^(.+)-(\d+)$/);
    const key = match ? match[1] : `__single__${row.arrayId}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  });
  const grouped = [];
  const warnings = [];
  buckets.forEach((members) => {
    if (members.length === 1 || !canGroupTOFProjectRows_(members)) {
      if (members.length > 1) {
        warnings.push(
          `Artemis arrays ${members.map((row) => row.arrayId).join(', ')} ` +
          'share a prefix but not common geometry, so they were not grouped.',
        );
      }
      members.forEach((row) => grouped.push(cloneTOFMetricRow_(row)));
      return;
    }
    const aggregate = calculateTOFWeightedAggregate_(members);
    aggregate.arrayId = members.map((row) => row.arrayId).join(' + ');
    aggregate.members = members.map((row) => row.arrayId);
    aggregate.azimuth = members[0].azimuth;
    aggregate.pitch = members[0].pitch;
    grouped.push(aggregate);
  });
  return {rows: grouped, warnings};
}

function canGroupTOFProjectRows_(rows) {
  return rows.every((row) => Number(row.panelCount) > 0) &&
    rows.every((row) =>
      Number.isFinite(row.azimuth) && Number.isFinite(row.pitch),
    ) &&
    rows.every((row) =>
      circularTOFDifference_(rows[0].azimuth, row.azimuth) <=
        TOF_COMPARISON_CONFIG.EXACT_ANGLE_TOLERANCE &&
      Math.abs(rows[0].pitch - row.pitch) <=
        TOF_COMPARISON_CONFIG.EXACT_PITCH_TOLERANCE,
    );
}

function matchTOFArrays_(pdfRows, projectRows) {
  if (pdfRows.length + projectRows.length === 0) {
    return {matches: [], unmatchedPdf: [], unmatchedProject: []};
  }
  let pdfIndexes = pdfRows.map((row, index) => index);
  let projectIndexes = projectRows.map((row, index) => index);
  const matches = [];

  // Stage 1 maximizes identical Panel Count matches. Geometry selects the
  // nearest candidate only when a repeated count creates several options.
  const exactPanelMatches = solveTOFMatchingStage_(
    pdfRows,
    projectRows,
    pdfIndexes,
    projectIndexes,
    (pdf, project) =>
      Number.isFinite(pdf.panelCount) &&
      Number.isFinite(project.panelCount) &&
      Math.abs(pdf.panelCount - project.panelCount) < 0.000001,
    calculateTOFGeometryTieBreakCost_,
    'exact-panel',
  );
  matches.push.apply(matches, exactPanelMatches);
  const matchedPdf = new Set(exactPanelMatches.map((match) => match.pdfIndex));
  const matchedProject = new Set(
    exactPanelMatches.map((match) => match.projectIndex),
  );
  pdfIndexes = pdfIndexes.filter((index) => !matchedPdf.has(index));
  projectIndexes = projectIndexes.filter((index) => !matchedProject.has(index));

  // When both sources contain the same number of arrays, complete the
  // one-to-one assignment even if a remaining pair is distant. Those pairs
  // are kept visible as Forced Nearest Match and require human review.
  const forceCompleteAssignment = pdfRows.length === projectRows.length;
  const fallbackMatches = solveTOFMatchingStage_(
    pdfRows,
    projectRows,
    pdfIndexes,
    projectIndexes,
    (pdf, project) => forceCompleteAssignment ||
      isTOFApproximatePanelMatch_(pdf, project),
    calculateTOFPanelFirstSelectionCost_,
    forceCompleteAssignment ? 'forced-complete' : 'nearest-panel',
  );
  matches.push.apply(matches, fallbackMatches);
  fallbackMatches.forEach((match) => {
    matchedPdf.add(match.pdfIndex);
    matchedProject.add(match.projectIndex);
  });

  matches.sort((left, right) => left.pdfIndex - right.pdfIndex);
  return {
    matches: matches.map((match) => {
      const pdf = pdfRows[match.pdfIndex];
      const project = projectRows[match.projectIndex];
      const displayCost = calculateTOFMatchCost_(pdf, project);
      return {
        pdf,
        project,
        stage: match.stage,
        cost: Number.isFinite(displayCost)
          ? roundTOFNumber_(displayCost)
          : '',
      };
    }),
    unmatchedPdf: pdfRows.filter((row, index) => !matchedPdf.has(index)),
    unmatchedProject: projectRows.filter(
      (row, index) => !matchedProject.has(index),
    ),
  };
}

function solveTOFMatchingStage_(
  pdfRows,
  projectRows,
  pdfIndexes,
  projectIndexes,
  eligibility,
  costFunction,
  stage,
) {
  const leftCount = pdfIndexes.length;
  const rightCount = projectIndexes.length;
  const size = leftCount + rightCount;
  if (leftCount === 0 || rightCount === 0) return [];
  const eligible = Array.from({length: leftCount}, () =>
    Array(rightCount).fill(false),
  );
  const realCosts = Array.from({length: leftCount}, () =>
    Array(rightCount).fill(TOF_COMPARISON_CONFIG.INELIGIBLE_COST),
  );
  let maximumPairCost = 0;
  for (let left = 0; left < leftCount; left += 1) {
    for (let right = 0; right < rightCount; right += 1) {
      const pdf = pdfRows[pdfIndexes[left]];
      const project = projectRows[projectIndexes[right]];
      if (!eligibility(pdf, project)) continue;
      eligible[left][right] = true;
      const pairCost = Math.max(Number(costFunction(pdf, project)) || 0, 0) +
        left * 0.000001 + right * 0.00000001;
      realCosts[left][right] = pairCost;
      maximumPairCost = Math.max(maximumPairCost, pairCost);
    }
  }
  // A missing pair is more expensive than every eligible complete assignment,
  // which makes the Hungarian solution maximize valid match cardinality first.
  const unmatchedSideCost = Math.min(
    (maximumPairCost + 1) * (size + 1),
    TOF_COMPARISON_CONFIG.INELIGIBLE_COST / 10,
  );
  const matrix = Array.from({length: size}, (_, row) =>
    Array.from({length: size}, (_, column) => {
      if (row < leftCount && column < rightCount) {
        return realCosts[row][column];
      }
      if (row < leftCount || column < rightCount) {
        return unmatchedSideCost;
      }
      return 0;
    }),
  );
  const assignment = solveTOFHungarian_(matrix);
  const matches = [];
  assignment.forEach((column, row) => {
    if (
      row < leftCount && column < rightCount && eligible[row][column]
    ) {
      matches.push({
        pdfIndex: pdfIndexes[row],
        projectIndex: projectIndexes[column],
        stage,
      });
    }
  });
  return matches;
}

function solveTOFHungarian_(cost) {
  const size = cost.length;
  const u = Array(size + 1).fill(0);
  const v = Array(size + 1).fill(0);
  const p = Array(size + 1).fill(0);
  const way = Array(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column0 = 0;
    const minValue = Array(size + 1).fill(Infinity);
    const used = Array(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = p[column0];
      let delta = Infinity;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const current = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (current < minValue[column]) {
          minValue[column] = current;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }
      column0 = column1;
    } while (p[column0] !== 0);
    do {
      const column1 = way[column0];
      p[column0] = p[column1];
      column0 = column1;
    } while (column0 !== 0);
  }
  const assignment = Array(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    if (p[column] > 0) assignment[p[column] - 1] = column - 1;
  }
  return assignment;
}

function isTOFApproximatePanelMatch_(pdf, project) {
  if (!Number.isFinite(pdf.panelCount) || !Number.isFinite(project.panelCount)) {
    return false;
  }
  const difference = Math.abs(pdf.panelCount - project.panelCount);
  const largest = Math.max(Math.abs(pdf.panelCount), Math.abs(project.panelCount));
  const percentage = largest > 0 ? difference / largest : 0;
  return difference <= TOF_COMPARISON_CONFIG.MAX_PANEL_DIFFERENCE ||
    percentage <= TOF_COMPARISON_CONFIG.MAX_PANEL_PERCENT_DIFFERENCE;
}

function isTOFPanelAndGeometryMatch_(pdf, project) {
  return Number.isFinite(pdf.panelCount) &&
    Number.isFinite(project.panelCount) &&
    Number.isFinite(pdf.azimuth) &&
    Number.isFinite(project.azimuth) &&
    Number.isFinite(pdf.pitch) &&
    Number.isFinite(project.pitch) &&
    Math.abs(pdf.panelCount - project.panelCount) < 0.000001 &&
    circularTOFDifference_(pdf.azimuth, project.azimuth) <=
      TOF_COMPARISON_CONFIG.MAX_AZIMUTH_DIFFERENCE &&
    Math.abs(pdf.pitch - project.pitch) <=
      TOF_COMPARISON_CONFIG.MAX_PITCH_DIFFERENCE;
}

function calculateTOFGeometryTieBreakCost_(pdf, project) {
  const azimuthCost = Number.isFinite(pdf.azimuth) &&
    Number.isFinite(project.azimuth)
    ? circularTOFDifference_(pdf.azimuth, project.azimuth)
    : 500;
  const pitchCost = Number.isFinite(pdf.pitch) && Number.isFinite(project.pitch)
    ? Math.abs(pdf.pitch - project.pitch)
    : 500;
  return azimuthCost * 100 + pitchCost;
}

function calculateTOFPanelFirstSelectionCost_(pdf, project) {
  if (!Number.isFinite(pdf.panelCount) || !Number.isFinite(project.panelCount)) {
    return TOF_COMPARISON_CONFIG.MISSING_PANEL_COST +
      calculateTOFGeometryTieBreakCost_(pdf, project);
  }
  const difference = Math.abs(pdf.panelCount - project.panelCount);
  return difference * TOF_COMPARISON_CONFIG.PANEL_PRIORITY_WEIGHT +
    calculateTOFGeometryTieBreakCost_(pdf, project);
}

function calculateTOFMatchCost_(pdf, project) {
  if (
    !Number.isFinite(pdf.panelCount) ||
    !Number.isFinite(project.panelCount) ||
    !Number.isFinite(pdf.azimuth) ||
    !Number.isFinite(project.azimuth) ||
    !Number.isFinite(pdf.pitch) ||
    !Number.isFinite(project.pitch)
  ) {
    return null;
  }
  return 20 * Math.abs(pdf.panelCount - project.panelCount) +
    circularTOFDifference_(pdf.azimuth, project.azimuth) +
    2 * Math.abs(pdf.pitch - project.pitch);
}

function classifyTOFMatch_(match) {
  const panelsAvailable = Number.isFinite(match.pdf.panelCount) &&
    Number.isFinite(match.project.panelCount);
  const panelDifference = panelsAvailable
    ? Math.abs(match.pdf.panelCount - match.project.panelCount)
    : null;
  if (Number.isFinite(panelDifference) && panelDifference < 0.000001) {
    return isTOFPanelAndGeometryMatch_(match.pdf, match.project)
      ? 'Exact Panel and Geometry Match'
      : 'Exact Panel Match';
  }
  if (
    match.stage === 'forced-complete' &&
    !isTOFApproximatePanelMatch_(match.pdf, match.project)
  ) {
    return 'Forced Nearest Match';
  }
  return 'Probable Nearest Match';
}

function buildTOFMatchNotes_(match, matchType, sharedWarnings) {
  const panelDifference = Number.isFinite(match.pdf.panelCount) &&
    Number.isFinite(match.project.panelCount)
    ? Math.abs(match.pdf.panelCount - match.project.panelCount)
    : null;
  const largestPanelCount = Number.isFinite(panelDifference)
    ? Math.max(Math.abs(match.pdf.panelCount), Math.abs(match.project.panelCount))
    : 0;
  const percentageDifference = Number.isFinite(panelDifference) &&
    largestPanelCount > 0
    ? panelDifference / largestPanelCount * 100
    : null;
  const azimuthDifference = Number.isFinite(match.pdf.azimuth) &&
    Number.isFinite(match.project.azimuth)
    ? circularTOFDifference_(match.pdf.azimuth, match.project.azimuth)
    : null;
  const pitchDifference = Number.isFinite(match.pdf.pitch) &&
    Number.isFinite(match.project.pitch)
    ? Math.abs(match.pdf.pitch - match.project.pitch)
    : null;
  let explanation = '';
  if (matchType === 'Exact Panel and Geometry Match') {
    explanation =
      'Matched first by identical Panel Count, then by nearest circular ' +
      'Azimuth and Pitch.';
  } else if (matchType === 'Exact Panel Match') {
    explanation =
      'Matched by identical Panel Count. Geometry exceeds the automatic ' +
      `review tolerance (Azimuth difference: ${formatTOFDiagnosticNumber_(
        azimuthDifference,
      )}°, Pitch difference: ${formatTOFDiagnosticNumber_(pitchDifference)}°).`;
  } else if (matchType === 'Probable Nearest Match') {
    explanation =
      `Matched by nearest available Panel Count fallback (difference: ` +
      `${formatTOFDiagnosticNumber_(panelDifference)} panels, ` +
      `${formatTOFDiagnosticNumber_(percentageDifference)}%). Circular ` +
      'Azimuth and Pitch were used as tie-breakers.';
  } else {
    explanation =
      'Forced one-to-one fallback because Aurora and Artemis contain the ' +
      'same number of arrays and no close Panel Count candidate remained.';
  }
  if (match.project.members.length > 1) {
    explanation += ` Artemis arrays ${match.project.members.join(', ')} ` +
      'were safely grouped before matching.';
  }
  return [explanation].concat(sharedWarnings || []).filter(Boolean).join(' ');
}

function formatTOFDiagnosticNumber_(value) {
  return Number.isFinite(value) ? String(roundTOFNumber_(value)) : 'n.a.';
}

function circularTOFDifference_(left, right) {
  const difference = Math.abs(Number(left) - Number(right)) % 360;
  return Math.min(difference, 360 - difference);
}

function signedCircularTOFDelta_(pdfValue, projectValue) {
  if (!Number.isFinite(pdfValue) || !Number.isFinite(projectValue)) return '';
  let difference = (projectValue - pdfValue + 180) % 360;
  if (difference < 0) difference += 360;
  return roundTOFNumber_(difference - 180);
}

function calculateTOFWeightedAggregate_(rows) {
  const aggregate = createBlankTOFMetricRow_();
  aggregate.arrayId = '';
  aggregate.members = [];
  aggregate.panelCount = rows.reduce(
    (sum, row) => sum + (Number(row.panelCount) > 0 ? Number(row.panelCount) : 0),
    0,
  );
  ['annualTof', 'annualSolarAccess', 'annualTsrf'].forEach((field) => {
    aggregate[field] = weightedTOFValue_(rows, (row) => row[field]);
  });
  aggregate.months = TOF_COMPARISON_MONTHS.map((month, index) =>
    weightedTOFValue_(rows, (row) => row.months[index]),
  );
  return aggregate;
}

function weightedTOFValue_(rows, accessor) {
  let numerator = 0;
  let denominator = 0;
  rows.forEach((row) => {
    const panels = Number(row.panelCount);
    const value = accessor(row);
    if (panels > 0 && Number.isFinite(value)) {
      numerator += value * panels;
      denominator += panels;
    }
  });
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Writes separate arithmetic means from every original Aurora and Artemis
 * geometry row, then calculates each aggregate delta as Artemis mean minus
 * Aurora mean. Matching status does not affect these source-level averages.
 */
function applyTOFAverageGeometryValues_(row, auroraRows, artemisRows) {
  const headers = getTOFValuesComparisonHeaders_();
  const auroraAzimuth = averageTOFMetricValues_(auroraRows, 'azimuth');
  const artemisAzimuth = averageTOFMetricValues_(artemisRows, 'azimuth');
  const auroraPitch = averageTOFMetricValues_(auroraRows, 'pitch');
  const artemisPitch = averageTOFMetricValues_(artemisRows, 'pitch');
  row[headers.indexOf('Aurora Azimuth')] = auroraAzimuth;
  row[headers.indexOf('Artemis Azimuth')] = artemisAzimuth;
  row[headers.indexOf('Delta Azimuth')] = toTOFDelta_(
    auroraAzimuth,
    artemisAzimuth,
  );
  row[headers.indexOf('Aurora Pitch')] = auroraPitch;
  row[headers.indexOf('Artemis Pitch')] = artemisPitch;
  row[headers.indexOf('Delta Pitch')] = toTOFDelta_(
    auroraPitch,
    artemisPitch,
  );
  return row;
}

function averageTOFMetricValues_(rows, field) {
  return averageTOFValues_((rows || []).map((sourceRow) =>
    sourceRow ? sourceRow[field] : null,
  ));
}

function averageTOFValues_(values) {
  const numericValues = (values || []).filter(Number.isFinite);
  if (numericValues.length === 0) return '';
  const total = numericValues.reduce((sum, value) => sum + value, 0);
  return roundTOFNumber_(total / numericValues.length);
}

function buildTOFComparisonRow_(
  candidate,
  pdf,
  project,
  status,
  matchType,
  matchCost,
  notes,
  signature,
  rowOrder,
  error,
) {
  const row = [
    candidate.projectId,
    candidate.projectUrl,
    candidate.sourceDriveFileId,
    candidate.sourceReceivedAt || '',
    candidate.pdfSummaryUrl,
    candidate.projectSummaryUrl,
    candidate.pdfMonthlyUrl,
    candidate.projectMonthlyUrl,
    new Date(),
    status,
    matchType,
    matchCost,
    pdf ? pdf.arrayId : '',
    project ? project.members.join(' + ') : '',
  ];
  appendTOFMetricTriplet_(row, pdf, project, 'panelCount', false);
  appendTOFMetricTriplet_(row, pdf, project, 'azimuth', true);
  appendTOFMetricTriplet_(row, pdf, project, 'pitch', false);
  appendTOFMetricTriplet_(row, pdf, project, 'annualTof', false);
  appendTOFMetricTriplet_(row, pdf, project, 'annualSolarAccess', false);
  appendTOFMetricTriplet_(row, pdf, project, 'annualTsrf', false);
  TOF_COMPARISON_MONTHS.forEach((month, index) => {
    const pdfValue = pdf && pdf.months ? pdf.months[index] : null;
    const projectValue = project && project.months ? project.months[index] : null;
    row.push(toTOFCellNumber_(pdfValue));
    row.push(toTOFCellNumber_(projectValue));
    row.push(toTOFDelta_(pdfValue, projectValue));
  });
  row.push(truncateTOFComparisonText_(notes, 3000));
  row.push(signature);
  row.push(TOF_COMPARISON_CONFIG.ALGORITHM_VERSION);
  row.push(rowOrder);
  row.push(truncateTOFComparisonText_(error, 3000));
  return row.map(safeTOFCellValue_);
}

function appendTOFMetricTriplet_(row, pdf, project, field, circular) {
  const pdfValue = pdf ? pdf[field] : null;
  const projectValue = project ? project[field] : null;
  row.push(toTOFCellNumber_(pdfValue));
  row.push(toTOFCellNumber_(projectValue));
  row.push(circular
    ? signedCircularTOFDelta_(pdfValue, projectValue)
    : toTOFDelta_(pdfValue, projectValue));
}

function buildTOFStatusRow_(
  candidate,
  status,
  matchType,
  notes,
  signature,
  error,
) {
  return buildTOFComparisonRow_(
    candidate,
    null,
    null,
    status,
    matchType,
    '',
    notes,
    signature,
    1,
    error,
  );
}

function getTOFValuesComparisonHeaders_() {
  const headers = [
    'Project ID',
    'Project URL',
    'Source Drive File ID',
    'Source Received At',
    'Aurora Summary CSV URL',
    'Artemis Summary CSV URL',
    'Aurora Monthly CSV URL',
    'Artemis Monthly CSV URL',
    'Compared At',
    'Comparison Status',
    'Match Type',
    'Match Cost',
    'Aurora Array ID',
    'Artemis Array ID(s)',
    'Aurora Panel Count',
    'Artemis Panel Count',
    'Delta Panel Count',
    'Aurora Azimuth',
    'Artemis Azimuth',
    'Delta Azimuth',
    'Aurora Pitch',
    'Artemis Pitch',
    'Delta Pitch',
    'Aurora Annual TOF',
    'Artemis Annual TOF',
    'Delta Annual TOF (pp)',
    'Aurora Annual Solar Access',
    'Artemis Annual Solar Access',
    'Delta Annual Solar Access (pp)',
    'Aurora Annual TSRF',
    'Artemis Annual TSRF',
    'Delta Annual TSRF (pp)',
  ];
  TOF_COMPARISON_MONTHS.forEach((month) => {
    headers.push(`Aurora ${month}`);
    headers.push(`Artemis ${month}`);
    headers.push(`Delta ${month} (pp)`);
  });
  return headers.concat([
    'Notes',
    'Source Signature',
    'Comparison Version',
    'Row Order',
    'Error',
  ]);
}

function getOrCreateTOFValuesComparisonSheet_(spreadsheet) {
  const headers = getTOFValuesComparisonHeaders_();
  const legacyHeaders = getLegacyTOFValuesComparisonHeaders_();
  const sheet = resolveTOFValuesComparisonSheet_(spreadsheet);
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      headers.length - sheet.getMaxColumns(),
    );
  }
  const existingHeaders = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
      .map((value) => String(value).trim())
    : [];
  const populated = existingHeaders.some((value) => value !== '');
  if (populated && !TOFComparisonArraysEqual_(existingHeaders, headers)) {
    if (TOFComparisonArraysEqual_(existingHeaders, legacyHeaders)) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatTOFValuesComparisonSheet_(sheet, Math.max(sheet.getLastRow(), 1));
      console.log(
        `${TOF_COMPARISON_CONFIG.SHEET_NAME} headers migrated from ` +
        'PDF/Project to Aurora/Artemis.',
      );
    } else {
      throw new Error(
        `${TOF_COMPARISON_CONFIG.SHEET_NAME} has an unexpected schema. ` +
        'Preserve the sheet and review its header row before rerunning setup.',
      );
    }
  }
  if (!populated) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    formatTOFValuesComparisonSheet_(sheet, 1);
  }
  return sheet;
}

/**
 * Resolves the canonical comparison sheet without discarding user data.
 *
 * Migration rules:
 * - Prefer the canonical sheet when it already exists.
 * - Rename the legacy sheet in place when it is the only matching sheet.
 * - Create the canonical sheet only when neither name exists.
 * - When both names exist, leave the legacy duplicate untouched for manual
 *   review and continue exclusively with the canonical sheet.
 */
function resolveTOFValuesComparisonSheet_(spreadsheet) {
  const canonicalName = TOF_COMPARISON_CONFIG.SHEET_NAME;
  const legacyName = TOF_COMPARISON_CONFIG.LEGACY_SHEET_NAME;
  const canonicalSheet = spreadsheet.getSheetByName(canonicalName);
  const legacySheet = spreadsheet.getSheetByName(legacyName);

  if (canonicalSheet) {
    if (legacySheet) {
      console.warn(
        `Both "${canonicalName}" and legacy "${legacyName}" exist. ` +
        `Using "${canonicalName}" and leaving the legacy sheet unchanged ` +
        'for manual review.',
      );
    }
    return canonicalSheet;
  }

  if (legacySheet) {
    legacySheet.setName(canonicalName);
    console.log(
      `Renamed legacy sheet "${legacyName}" to "${canonicalName}" in place.`,
    );
    return legacySheet;
  }

  console.log(`Creating managed sheet "${canonicalName}".`);
  return spreadsheet.insertSheet(canonicalName);
}

function getLegacyTOFValuesComparisonHeaders_() {
  return getTOFValuesComparisonHeaders_().map((header) => {
    if (TOF_COMPARISON_LEGACY_HEADER_BY_CURRENT[header]) {
      return TOF_COMPARISON_LEGACY_HEADER_BY_CURRENT[header];
    }
    if (/^Aurora (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(header)) {
      return header.replace(/^Aurora /, 'PDF ');
    }
    if (/^Artemis (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(header)) {
      return header.replace(/^Artemis /, 'Project ');
    }
    return header;
  });
}

function loadExistingTOFComparisonState_(sheet) {
  const headers = getTOFValuesComparisonHeaders_();
  if (sheet.getLastRow() < 2) return {rows: [], byProjectId: new Map()};
  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, headers.length)
    .getValues();
  const display = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, headers.length)
    .getDisplayValues();
  const index = {
    projectId: headers.indexOf('Project ID'),
    sourceDriveFileId: headers.indexOf('Source Drive File ID'),
    pdfSummary: headers.indexOf('Aurora Summary CSV URL'),
    projectSummary: headers.indexOf('Artemis Summary CSV URL'),
    pdfMonthly: headers.indexOf('Aurora Monthly CSV URL'),
    projectMonthly: headers.indexOf('Artemis Monthly CSV URL'),
    status: headers.indexOf('Comparison Status'),
    signature: headers.indexOf('Source Signature'),
    version: headers.indexOf('Comparison Version'),
  };
  const byProjectId = new Map();
  display.forEach((row) => {
    const projectId = String(row[index.projectId] || '').trim();
    const key = projectId.toLowerCase();
    if (!key || byProjectId.has(key)) return;
    byProjectId.set(key, {
      sourceDriveFileId: String(row[index.sourceDriveFileId] || '').trim(),
      pdfSummaryUrl: extractTOFUrl_(row[index.pdfSummary]),
      projectSummaryUrl: extractTOFUrl_(row[index.projectSummary]),
      pdfMonthlyUrl: extractTOFUrl_(row[index.pdfMonthly]),
      projectMonthlyUrl: extractTOFUrl_(row[index.projectMonthly]),
      status: String(row[index.status] || '').trim(),
      signature: String(row[index.signature] || '').trim(),
      version: String(row[index.version] || '').trim(),
    });
  });
  return {rows, byProjectId};
}

function rewriteTOFValuesComparisonRows_(sheet, rows) {
  const headers = getTOFValuesComparisonHeaders_();
  const previousRows = Math.max(sheet.getLastRow() - 1, 0);
  if (previousRows > 0) {
    sheet.getRange(2, 1, previousRows, headers.length).clearContent();
  }
  if (rows.length > 0) {
    if (sheet.getMaxRows() < rows.length + 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
  }
  formatTOFValuesComparisonSheet_(sheet, rows.length + 1);
}

function formatTOFValuesComparisonSheet_(sheet, lastRow) {
  const headers = getTOFValuesComparisonHeaders_();
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  sheet.setTabColor(TOF_COMPARISON_CONFIG.TAB_COLOR);
  sheet.setHiddenGridlines(true);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground(TOF_COMPARISON_CONFIG.HEADER_BACKGROUND)
    .setFontColor(TOF_COMPARISON_CONFIG.HEADER_FONT_COLOR)
    .setFontFamily(TOF_COMPARISON_CONFIG.BODY_FONT_FAMILY)
    .setFontSize(10)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(
      true,
      true,
      true,
      true,
      true,
      true,
      '#ffffff',
      SpreadsheetApp.BorderStyle.SOLID,
    );
  applyTOFComparisonHeaderPalette_(sheet, headers);
  sheet.setRowHeight(1, 42);
  sheet.setColumnWidth(1, 245);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidths(3, 2, 165);
  sheet.setColumnWidths(5, 4, 230);
  sheet.setColumnWidths(9, 6, 145);
  sheet.setColumnWidths(15, headers.length - 15, 125);
  const notesColumn = headers.indexOf('Notes') + 1;
  const errorColumn = headers.indexOf('Error') + 1;
  sheet.setColumnWidth(notesColumn, 360);
  sheet.setColumnWidth(errorColumn, 300);
  let projectGroups = 0;
  if (lastRow > 1) {
    const bodyRange = sheet.getRange(2, 1, lastRow - 1, headers.length);
    bodyRange
      .setFontFamily(TOF_COMPARISON_CONFIG.BODY_FONT_FAMILY)
      .setFontSize(10)
      .setFontColor(TOF_COMPARISON_CONFIG.BODY_FONT_COLOR)
      .setVerticalAlignment('middle')
      .setBorder(false, false, false, false, false, false);
    const groups = getTOFProjectGroups_(sheet, lastRow);
    projectGroups = groups.length;
    applyTOFProjectBanding_(sheet, lastRow, headers.length, groups);
    applyTOFComparisonColumnPalette_(sheet, lastRow, headers);
    applyTOFProjectGroupBorders_(sheet, headers.length, groups);
    applyTOFComparisonStatusPalette_(sheet, lastRow, headers);
    sheet.getRange(2, 4, lastRow - 1, 1)
      .setNumberFormat(TOF_COMPARISON_CONFIG.DATE_FORMAT);
    sheet.getRange(2, 9, lastRow - 1, 1)
      .setNumberFormat(TOF_COMPARISON_CONFIG.DATE_FORMAT);
    sheet.getRange(2, 12, lastRow - 1, 1).setNumberFormat('0.####');
    sheet.getRange(2, 15, lastRow - 1, headers.length - 19)
      .setNumberFormat('0.####');
    [2, 5, 6, 7, 8].forEach((column) =>
      sheet.getRange(2, column, lastRow - 1, 1).setShowHyperlink(true),
    );
    sheet.getRange(2, notesColumn, lastRow - 1, 1).setWrap(true);
    sheet.getRange(2, errorColumn, lastRow - 1, 1).setWrap(true);
  }
  const signatureColumn = headers.indexOf('Source Signature') + 1;
  const versionColumn = headers.indexOf('Comparison Version') + 1;
  const orderColumn = headers.indexOf('Row Order') + 1;
  sheet.hideColumns(signatureColumn, 3);
  if (errorColumn <= signatureColumn + 2) sheet.showColumns(errorColumn);
  return projectGroups;
}

function applyTOFComparisonHeaderPalette_(sheet, headers) {
  setTOFHeaderBackgroundByPrefix_(
    sheet,
    headers,
    'Aurora ',
    TOF_COMPARISON_CONFIG.AURORA_HEADER_BACKGROUND,
  );
  setTOFHeaderBackgroundByPrefix_(
    sheet,
    headers,
    'Artemis ',
    TOF_COMPARISON_CONFIG.ARTEMIS_HEADER_BACKGROUND,
  );
  setTOFHeaderBackgroundByPrefix_(
    sheet,
    headers,
    'Delta ',
    TOF_COMPARISON_CONFIG.DELTA_HEADER_BACKGROUND,
  );
  setTOFHeaderBackgrounds_(sheet, headers, [
    'Notes',
    'Source Signature',
    'Comparison Version',
    'Row Order',
  ], TOF_COMPARISON_CONFIG.SUPPORT_HEADER_BACKGROUND);
  setTOFHeaderBackgrounds_(
    sheet,
    headers,
    ['Error'],
    TOF_COMPARISON_CONFIG.ERROR_HEADER_BACKGROUND,
  );
}

function setTOFHeaderBackgroundByPrefix_(sheet, headers, prefix, color) {
  const names = headers.filter((header) => String(header).indexOf(prefix) === 0);
  setTOFHeaderBackgrounds_(sheet, headers, names, color);
}

function setTOFHeaderBackgrounds_(sheet, headers, names, color) {
  const ranges = names
    .map((name) => headers.indexOf(name) + 1)
    .filter((column) => column > 0)
    .map((column) => `${toTOFA1Column_(column)}1`);
  if (ranges.length > 0) sheet.getRangeList(ranges).setBackground(color);
}

function applyTOFProjectBanding_(sheet, lastRow, columnCount, groups) {
  if (groups.length === 0) return;
  const lastColumn = toTOFA1Column_(columnCount);
  sheet.getRange(2, 1, lastRow - 1, columnCount)
    .setBackground(TOF_COMPARISON_CONFIG.PROJECT_BAND_PRIMARY);
  const secondaryRanges = groups
    .filter((group, index) => index % 2 === 1)
    .map((group) => `A${group.start}:${lastColumn}${group.end}`);
  if (secondaryRanges.length > 0) {
    sheet.getRangeList(secondaryRanges)
      .setBackground(TOF_COMPARISON_CONFIG.PROJECT_BAND_SECONDARY);
  }
  sheet.getRange(2, 1, lastRow - 1, 1).setFontWeight('bold');
}

function applyTOFComparisonColumnPalette_(sheet, lastRow, headers) {
  setTOFDataBackgroundByPrefix_(
    sheet,
    lastRow,
    headers,
    'Aurora ',
    TOF_COMPARISON_CONFIG.AURORA_DATA_BACKGROUND,
  );
  setTOFDataBackgroundByPrefix_(
    sheet,
    lastRow,
    headers,
    'Artemis ',
    TOF_COMPARISON_CONFIG.ARTEMIS_DATA_BACKGROUND,
  );
  setTOFDataBackgroundByPrefix_(
    sheet,
    lastRow,
    headers,
    'Delta ',
    TOF_COMPARISON_CONFIG.DELTA_DATA_BACKGROUND,
  );
}

function setTOFDataBackgroundByPrefix_(sheet, lastRow, headers, prefix, color) {
  const ranges = headers
    .map((header, index) => ({header: String(header), column: index + 1}))
    .filter((item) => item.header.indexOf(prefix) === 0)
    .map((item) => {
      const column = toTOFA1Column_(item.column);
      return `${column}2:${column}${lastRow}`;
    });
  if (ranges.length > 0) sheet.getRangeList(ranges).setBackground(color);
}

function applyTOFProjectGroupBorders_(sheet, columnCount, groups) {
  if (groups.length === 0) return;
  const lastColumn = toTOFA1Column_(columnCount);
  const ranges = groups.map(
    (group) => `A${group.start}:${lastColumn}${group.end}`,
  );
  sheet.getRangeList(ranges).setBorder(
    true,
    null,
    null,
    null,
    null,
    null,
    TOF_COMPARISON_CONFIG.PROJECT_BORDER_COLOR,
    SpreadsheetApp.BorderStyle.SOLID_MEDIUM,
  );
}

function getTOFProjectGroups_(sheet, lastRow) {
  if (lastRow < 2) return [];
  const projectIds = sheet.getRange(2, 1, lastRow - 1, 1)
    .getDisplayValues()
    .map((row) => String(row[0] || '').trim().toLowerCase());
  const groups = [];
  let start = 2;
  let current = projectIds[0] || '__blank_row_2';
  for (let index = 1; index < projectIds.length; index += 1) {
    const projectId = projectIds[index] || `__blank_row_${index + 2}`;
    if (projectId === current) continue;
    groups.push({start, end: index + 1});
    start = index + 2;
    current = projectId;
  }
  groups.push({start, end: lastRow});
  return groups;
}

function applyTOFComparisonStatusPalette_(sheet, lastRow, headers) {
  const statusColumn = headers.indexOf('Comparison Status') + 1;
  if (statusColumn < 1 || lastRow < 2) return;
  const values = sheet.getRange(2, statusColumn, lastRow - 1, 1)
    .getDisplayValues()
    .map((row) => String(row[0] || '').trim());
  [
    {value: 'Compared', background: '#e6f4ea', font: '#137333'},
    {value: 'Review Required', background: '#fef7e0', font: '#b06000'},
    {value: 'Pending Sources', background: '#e8f0fe', font: '#174ea6'},
    {value: 'Error', background: '#fce8e6', font: '#b3261e'},
  ].forEach((style) => {
    const ranges = buildTOFContiguousValueRanges_(
      values,
      statusColumn,
      (value) => value === style.value,
    );
    if (ranges.length === 0) return;
    sheet.getRangeList(ranges)
      .setBackground(style.background)
      .setFontColor(style.font)
      .setFontWeight('bold');
  });
  const errorColumn = headers.indexOf('Error') + 1;
  if (errorColumn < 1) return;
  const errors = sheet.getRange(2, errorColumn, lastRow - 1, 1)
    .getDisplayValues()
    .map((row) => String(row[0] || '').trim());
  const errorRanges = buildTOFContiguousValueRanges_(
    errors,
    errorColumn,
    (value) => value !== '',
  );
  if (errorRanges.length > 0) {
    sheet.getRangeList(errorRanges)
      .setBackground('#fce8e6')
      .setFontColor('#b3261e')
      .setFontWeight('bold');
  }
}

function buildTOFContiguousValueRanges_(values, columnNumber, predicate) {
  const ranges = [];
  const column = toTOFA1Column_(columnNumber);
  let start = null;
  values.forEach((value, index) => {
    const row = index + 2;
    if (predicate(value)) {
      if (start === null) start = row;
      return;
    }
    if (start !== null) {
      ranges.push(`${column}${start}:${column}${row - 1}`);
      start = null;
    }
  });
  if (start !== null) {
    ranges.push(`${column}${start}:${column}${lastRowFromValues_(values)}`);
  }
  return ranges;
}

function lastRowFromValues_(values) {
  return values.length + 1;
}

function toTOFA1Column_(columnNumber) {
  let column = Number(columnNumber);
  let label = '';
  while (column > 0) {
    const remainder = (column - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    column = Math.floor((column - 1) / 26);
  }
  return label;
}

function readTOFDriveCsv_(url) {
  const fileId = extractTOFDriveFileId_(url);
  const text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
  return {fileId, text, hash: hashTOFText_(text)};
}

function extractTOFDriveFileId_(url) {
  const decoded = decodeURIComponent(extractTOFUrl_(url));
  const match = decoded.match(/\/d\/([A-Za-z0-9_-]{20,})/) ||
    decoded.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error('A Google Drive CSV file ID could not be read.');
  return match[1];
}

function extractTOFUrl_(value) {
  const text = String(value || '').trim();
  const hyperlink = text.match(/^=HYPERLINK\("([^"]+)"/i);
  return hyperlink ? hyperlink[1] : text;
}

function buildTOFReferenceSignature_(candidate) {
  return hashTOFText_([
    TOF_COMPARISON_CONFIG.ALGORITHM_VERSION,
    candidate.sourceDriveFileId,
    candidate.pdfSummaryUrl,
    candidate.pdfMonthlyUrl,
    candidate.projectSummaryUrl,
    candidate.projectMonthlyUrl,
    candidate.projectDataStatus,
  ].join('|'));
}

function hashTOFText_(text) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ''),
    Utilities.Charset.UTF_8,
  );
  return digest.map((value) => {
    const byte = value < 0 ? value + 256 : value;
    return (`0${byte.toString(16)}`).slice(-2);
  }).join('');
}

function parseTOFNumber_(value, percentage) {
  const original = String(value === null || value === undefined ? '' : value)
    .trim();
  if (!original) return null;
  const cleaned = original
    .replace(/^'/, '')
    .replace(/,/g, '')
    .replace(/[%°]/g, '')
    .trim();
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) return null;
  if (percentage && original.indexOf('%') < 0 && Math.abs(numeric) <= 1) {
    return numeric * 100;
  }
  return numeric;
}

function normalizeTOFHeader_(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeTOFDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createBlankTOFMetricRow_() {
  return {
    arrayId: '',
    panelCount: null,
    azimuth: null,
    pitch: null,
    annualTof: null,
    annualSolarAccess: null,
    annualTsrf: null,
    months: Array(12).fill(null),
    members: [],
  };
}

function cloneTOFMetricRow_(row) {
  return {
    arrayId: row.arrayId,
    panelCount: row.panelCount,
    azimuth: row.azimuth,
    pitch: row.pitch,
    annualTof: row.annualTof,
    annualSolarAccess: row.annualSolarAccess,
    annualTsrf: row.annualTsrf,
    months: row.months.slice(),
    members: row.members.slice(),
  };
}

function toTOFCellNumber_(value) {
  return Number.isFinite(value) ? roundTOFNumber_(value) : '';
}

function toTOFDelta_(pdfValue, projectValue) {
  return Number.isFinite(pdfValue) && Number.isFinite(projectValue)
    ? roundTOFNumber_(projectValue - pdfValue)
    : '';
}

function roundTOFNumber_(value) {
  return Number(Number(value).toFixed(4));
}

function compareTOFOutputRows_(left, right) {
  const leftDate = normalizeTOFDate_(left[3]);
  const rightDate = normalizeTOFDate_(right[3]);
  const leftTime = leftDate ? leftDate.getTime() : 0;
  const rightTime = rightDate ? rightDate.getTime() : 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  const projectDifference = String(left[0]).localeCompare(String(right[0]));
  if (projectDifference !== 0) return projectDifference;
  const headers = getTOFValuesComparisonHeaders_();
  return Number(left[headers.indexOf('Row Order')] || 0) -
    Number(right[headers.indexOf('Row Order')] || 0);
}

function requireTOFComparisonHeader_(headers, header, sheetName) {
  const index = headers.indexOf(header);
  if (index < 0) throw new Error(`${sheetName} is missing required header ${header}.`);
  return index;
}

function TOFComparisonArraysEqual_(left, right) {
  return left.length === right.length && left.every(
    (value, index) => String(value) === String(right[index]),
  );
}

function safeTOFCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  const text = String(value);
  return /^[=+@]/.test(text) ? `'${text}` : text;
}

function truncateTOFComparisonText_(text, maxLength) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

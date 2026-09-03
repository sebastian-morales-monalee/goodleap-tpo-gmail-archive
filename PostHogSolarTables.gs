/**
 * GoodLeap TPO - PostHog project solar table synchronization
 *
 * This file belongs in the SAME Apps Script project as Code.gs,
 * PostHogSync.gs, and OpenAIPdfExtraction.gs. It reconstructs the two solar
 * tables stored in each Artemis project and writes their Drive CSV links to
 * PDF Analysis beside the equivalent PDF-derived CSV links.
 *
 * Lookup order:
 *   1) GoodLeap projects and active solar panels
 *   2) Artemis Sales projects and active solar panels
 *
 * The database extraction is deterministic and does not call OpenAI.
 * Array IDs are the project's native segment_index values. Only active panel
 * segments are exported when panel rows are available.
 *
 * Safe first-run sequence:
 *   1) setupPostHogSolarTableSync()
 *   2) testPostHogSolarTableConnection()
 *   3) previewPostHogSolarTableSync()
 *   4) syncPostHogSolarTables()
 *   5) previewPdfAnalysisComparisonCounts()
 *   6) backfillPdfAnalysisComparisonCounts()
 */

const POSTHOG_SOLAR_CONFIG = {
  SHEET_NAME: 'PDF Analysis',
  DEFAULT_GOODLEAP_PROJECTS_TABLE: 'goodleap_postgres_projects',
  DEFAULT_GOODLEAP_PANELS_TABLE: 'goodleap_postgres_solarpanels',
  DEFAULT_ARTEMIS_SALES_PANELS_TABLE: 'artemis_sales_postgres_solarpanels',
  DEFAULT_PROJECT_ID_FIELD: 'id',
  DEFAULT_ARRAY_STATS_FIELD: 'array_stats',
  DEFAULT_SOURCE_UPDATED_AT_FIELD: 'updated_at',
  DEFAULT_PANEL_PROJECT_ID_FIELD: 'project_id',
  DEFAULT_PANEL_SEGMENT_FIELD: 'segment_index',
  DEFAULT_PANEL_ACTIVE_FIELD: 'is_active',
  DEFAULT_PANEL_AZIMUTH_FIELD: 'azimuth',
  DEFAULT_PANEL_PITCH_FIELD: 'pitch',
  QUERY_BATCH_SIZE: 25,
  PREVIEW_LIMIT: 10,
  MAX_ROWS_PER_SYNC: 500,
  MAX_PANEL_GROUPS_PER_BATCH: 10000,
};

const POSTHOG_SOLAR_PROPERTY_KEYS = {
  GOODLEAP_PROJECTS_TABLE: 'POSTHOG_GOODLEAP_PROJECTS_TABLE',
  GOODLEAP_PANELS_TABLE: 'POSTHOG_GOODLEAP_SOLAR_PANELS_TABLE',
  ARTEMIS_SALES_PANELS_TABLE: 'POSTHOG_ARTEMIS_SALES_SOLAR_PANELS_TABLE',
  PROJECT_ID_FIELD: 'POSTHOG_SOLAR_PROJECT_ID_FIELD',
  ARRAY_STATS_FIELD: 'POSTHOG_SOLAR_ARRAY_STATS_FIELD',
  SOURCE_UPDATED_AT_FIELD: 'POSTHOG_SOLAR_SOURCE_UPDATED_AT_FIELD',
  PANEL_PROJECT_ID_FIELD: 'POSTHOG_SOLAR_PANEL_PROJECT_ID_FIELD',
  PANEL_SEGMENT_FIELD: 'POSTHOG_SOLAR_PANEL_SEGMENT_FIELD',
  PANEL_ACTIVE_FIELD: 'POSTHOG_SOLAR_PANEL_ACTIVE_FIELD',
  PANEL_AZIMUTH_FIELD: 'POSTHOG_SOLAR_PANEL_AZIMUTH_FIELD',
  PANEL_PITCH_FIELD: 'POSTHOG_SOLAR_PANEL_PITCH_FIELD',
};

const POSTHOG_SOLAR_REQUIRED_HEADERS = [
  'Source Drive File ID',
  'Project ID',
  'Application ID',
  'Source Filename',
  'Project Summary CSV URL',
  'Project Monthly CSV URL',
  'Project Data Source',
  'Project Data Synced At',
  'Project Data Status',
  'Project Data Error',
  'Extraction Status',
];

/**
 * Validates settings and upgrades PDF Analysis without querying PostHog.
 */
function setupPostHogSolarTableSync() {
  const settings = getPostHogSolarSettings_();
  const resources = getOrCreateResources_();
  const sheet = getOrCreateOpenAIPdfSheet_(resources.spreadsheet);

  console.log('PostHog solar table sync setup completed.');
  console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Derived sheet: ${sheet.getName()}`);
  console.log(`GoodLeap projects table: ${settings.goodLeapProjectsTable}`);
  console.log(`GoodLeap panels table: ${settings.goodLeapPanelsTable}`);
  console.log(
    `Artemis Sales projects table: ${settings.artemisSalesProjectsTable}`,
  );
  console.log(
    `Artemis Sales panels table: ${settings.artemisSalesPanelsTable}`,
  );
  console.log('The PostHog personal API key was found and was not logged.');

  return {
    sheet: sheet.getName(),
    goodLeapProjectsTable: settings.goodLeapProjectsTable,
    goodLeapPanelsTable: settings.goodLeapPanelsTable,
    artemisSalesProjectsTable: settings.artemisSalesProjectsTable,
    artemisSalesPanelsTable: settings.artemisSalesPanelsTable,
  };
}

/**
 * Verifies that both source pairs expose the required project and panel
 * fields. It reads at most one arbitrary row from each table and writes no
 * Sheet or Drive data.
 */
function testPostHogSolarTableConnection() {
  const settings = getPostHogSolarSettings_();
  const sources = buildPostHogSolarSources_(settings);
  const results = {};

  sources.forEach((source) => {
    const projectResponse = executePostHogHogQL_(
      [
        'SELECT',
        `  toString(${settings.projectIdField}) AS project_id,`,
        `  toString(${settings.arrayStatsField}) AS array_stats`,
        `FROM ${source.projectsTable}`,
        'LIMIT 1',
      ].join('\n'),
      `goodleap_solar_${source.queryLabel}_project_connection_test`,
    );
    const panelResponse = executePostHogHogQL_(
      [
        'SELECT',
        `  toString(${settings.panelProjectIdField}) AS project_id,`,
        `  ${settings.panelSegmentField} AS segment_index`,
        `FROM ${source.panelsTable}`,
        'LIMIT 1',
      ].join('\n'),
      `goodleap_solar_${source.queryLabel}_panel_connection_test`,
    );
    requirePostHogSolarColumns_(
      projectResponse,
      ['project_id', 'array_stats'],
      `${source.label} projects`,
    );
    requirePostHogSolarColumns_(
      panelResponse,
      ['project_id', 'segment_index'],
      `${source.label} panels`,
    );
    results[source.label] = {
      projectColumns: projectResponse.columns,
      panelColumns: panelResponse.columns,
    };
    console.log(`${source.label} solar table connection test passed.`);
  });

  return results;
}

/**
 * Queries a small sample and logs source and array counts. It creates neither
 * CSV files nor Sheet values.
 */
function previewPostHogSolarTableSync() {
  const resources = getOrCreateResources_();
  const sheet = resources.spreadsheet.getSheetByName(
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );
  if (!sheet) {
    throw new Error(
      'PDF Analysis does not exist. Run setupPostHogSolarTableSync() first.',
    );
  }
  const candidates = loadPostHogSolarCandidates_(sheet)
    .slice(0, POSTHOG_SOLAR_CONFIG.PREVIEW_LIMIT);
  const records = fetchPostHogSolarRecords_(
    candidates.map((candidate) => candidate.projectId),
  );
  let matched = 0;
  let notFound = 0;

  candidates.forEach((candidate) => {
    const record = records.get(candidate.projectId);
    if (!record) {
      notFound += 1;
      console.log(`[NOT FOUND] ${candidate.applicationId} | ${candidate.projectId}`);
      return;
    }
    const tables = buildPostHogSolarTables_(record);
    matched += 1;
    console.log(
      `[MATCH] ${candidate.applicationId} | ${candidate.projectId} | ` +
      `${record.source} | arrays=${tables.arrayCount} | ` +
      `panels=${tables.panelCount}`,
    );
    if (tables.notes.length > 0) {
      console.log(`[REVIEW] ${tables.notes.join(' ')}`);
    }
  });

  const stats = {previewed: candidates.length, matched, notFound};
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

/**
 * Reads a small sample of the existing PDF and project Summary CSV files and
 * logs their panel and array totals. It does not query PostHog or OpenAI and
 * does not write Sheet values.
 */
function previewPdfAnalysisComparisonCounts() {
  const resources = getOrCreateResources_();
  const sheet = resources.spreadsheet.getSheetByName(
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );
  if (!sheet) {
    throw new Error(
      'PDF Analysis does not exist. Run setupPostHogSolarTableSync() first.',
    );
  }
  const candidates = loadPdfAnalysisComparisonCandidates_(sheet)
    .filter((candidate) => candidate.pdfSummaryUrl || candidate.projectSummaryUrl)
    .slice(0, POSTHOG_SOLAR_CONFIG.PREVIEW_LIMIT);
  const cache = new Map();
  const stats = {previewed: candidates.length, complete: 0, partial: 0, errors: 0};

  candidates.forEach((candidate) => {
    const counts = calculatePdfAnalysisComparisonCounts_(candidate, cache);
    if (counts.errors.length > 0) {
      stats.errors += counts.errors.length;
      console.warn(
        `[COUNT REVIEW] ${candidate.applicationId} | ${counts.errors.join(' ')}`,
      );
    }
    const complete = Boolean(counts.pdf && counts.project);
    if (complete) {
      stats.complete += 1;
    } else {
      stats.partial += 1;
    }
    console.log(
      `[COUNT] ${candidate.applicationId} | ` +
      `PDF panels=${formatPdfAnalysisCountLog_(counts.pdf, 'panelCount')} ` +
      `arrays=${formatPdfAnalysisCountLog_(counts.pdf, 'arrayCount')} | ` +
      `Project panels=${formatPdfAnalysisCountLog_(counts.project, 'panelCount')} ` +
      `arrays=${formatPdfAnalysisCountLog_(counts.project, 'arrayCount')}`,
    );
  });

  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

/**
 * Historical backfill for the four at-a-glance comparison counts. Existing
 * CSV files in Drive are the source, so this function makes no PostHog or
 * OpenAI request. Missing or unreadable CSVs preserve any existing count.
 */
function backfillPdfAnalysisComparisonCounts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. Count backfill was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    const resources = getOrCreateResources_();
    const sheet = getOrCreateOpenAIPdfSheet_(resources.spreadsheet);
    if (sheet.getLastRow() < 2) {
      console.log('PDF Analysis has no data rows to backfill.');
      return {rows: 0, pdfUpdated: 0, projectUpdated: 0, errors: 0};
    }
    const candidates = loadPdfAnalysisComparisonCandidates_(sheet);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0]
      .map((value) => String(value).trim());
    const pdfPanelIndex = requireSheetHeaderIndex_(
      headers,
      'PDF Panel Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    );
    const projectPanelIndex = requireSheetHeaderIndex_(
      headers,
      'Project Panel Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    );
    const pdfArrayIndex = requireSheetHeaderIndex_(
      headers,
      'PDF Array Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    );
    const projectArrayIndex = requireSheetHeaderIndex_(
      headers,
      'Project Array Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    );
    const expectedIndexes = [
      pdfPanelIndex,
      projectPanelIndex,
      pdfArrayIndex,
      projectArrayIndex,
    ];
    expectedIndexes.forEach((index, offset) => {
      if (index !== pdfPanelIndex + offset) {
        throw new Error('PDF Analysis comparison count columns are not contiguous.');
      }
    });

    const output = sheet
      .getRange(2, pdfPanelIndex + 1, sheet.getLastRow() - 1, 4)
      .getValues();
    const cache = new Map();
    const stats = {
      rows: candidates.length,
      pdfUpdated: 0,
      projectUpdated: 0,
      usedExistingPdfArrayCount: 0,
      errors: 0,
    };

    candidates.forEach((candidate) => {
      const rowOffset = candidate.rowNumber - 2;
      const counts = calculatePdfAnalysisComparisonCounts_(candidate, cache);
      if (counts.pdf) {
        output[rowOffset][0] = counts.pdf.panelCount;
        output[rowOffset][2] = counts.pdf.arrayCount;
        stats.pdfUpdated += 1;
      } else if (Number.isFinite(candidate.existingSummaryArrayCount)) {
        output[rowOffset][2] = candidate.existingSummaryArrayCount;
        stats.usedExistingPdfArrayCount += 1;
      }
      if (counts.project) {
        output[rowOffset][1] = counts.project.panelCount;
        output[rowOffset][3] = counts.project.arrayCount;
        stats.projectUpdated += 1;
      }
      if (counts.errors.length > 0) {
        stats.errors += counts.errors.length;
        console.warn(
          `[COUNT BACKFILL REVIEW] ${candidate.applicationId} | ` +
          counts.errors.join(' '),
        );
      }
    });

    sheet
      .getRange(2, pdfPanelIndex + 1, output.length, 4)
      .setValues(output);
    SpreadsheetApp.flush();
    console.log(JSON.stringify(stats, null, 2));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

function loadPdfAnalysisComparisonCandidates_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const applicationIdIndex = requireSheetHeaderIndex_(
    headers,
    'Application ID',
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );
  const pdfSummaryIndex = requireSheetHeaderIndex_(
    headers,
    'PDF Summary CSV URL',
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );
  const projectSummaryIndex = requireSheetHeaderIndex_(
    headers,
    'Project Summary CSV URL',
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );
  const existingSummaryArrayIndex = requireSheetHeaderIndex_(
    headers,
    'Summary Array Count',
    POSTHOG_SOLAR_CONFIG.SHEET_NAME,
  );

  return values.slice(1).map((row, offset) => {
    const existingArrayCount = Number(row[existingSummaryArrayIndex]);
    return {
      rowNumber: offset + 2,
      applicationId: String(row[applicationIdIndex] || '').trim(),
      pdfSummaryUrl: String(row[pdfSummaryIndex] || '').trim(),
      projectSummaryUrl: String(row[projectSummaryIndex] || '').trim(),
      existingSummaryArrayCount: Number.isFinite(existingArrayCount)
        ? existingArrayCount
        : null,
    };
  });
}

function calculatePdfAnalysisComparisonCounts_(candidate, cache) {
  const result = {pdf: null, project: null, errors: []};
  [
    ['pdf', 'PDF', candidate.pdfSummaryUrl],
    ['project', 'Project', candidate.projectSummaryUrl],
  ].forEach(([key, label, url]) => {
    if (!url) {
      return;
    }
    try {
      result[key] = readPdfAnalysisSummaryCounts_(url, cache);
    } catch (error) {
      result.errors.push(`${label} Summary CSV: ${String(error)}`);
    }
  });
  return result;
}

function readPdfAnalysisSummaryCounts_(url, cache) {
  if (cache.has(url)) {
    const cached = cache.get(url);
    if (cached.error) {
      throw new Error(cached.error);
    }
    return cached.counts;
  }
  try {
    const fileId = extractPdfAnalysisDriveFileId_(url);
    const csv = DriveApp.getFileById(fileId)
      .getBlob()
      .getDataAsString('UTF-8');
    const rows = Utilities.parseCsv(csv);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('The CSV is empty.');
    }
    const headers = rows[0].map((value) =>
      String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase(),
    );
    const arrayIdIndex = headers.indexOf('array id');
    const panelCountIndex = headers.indexOf('panel count');
    if (arrayIdIndex < 0 || panelCountIndex < 0) {
      throw new Error('Array ID or Panel Count header was not found.');
    }
    let panelCount = 0;
    let arrayCount = 0;
    rows.slice(1).forEach((row) => {
      const arrayId = String(row[arrayIdIndex] || '').trim();
      if (!arrayId || /weighted\s+average/i.test(arrayId)) {
        return;
      }
      const numericText = String(row[panelCountIndex] || '')
        .replace(/,/g, '')
        .trim();
      const panels = Number(numericText);
      if (!Number.isFinite(panels) || panels < 0) {
        throw new Error(`Invalid Panel Count for Array ID ${arrayId}.`);
      }
      panelCount += panels;
      arrayCount += 1;
    });
    const counts = {panelCount, arrayCount};
    cache.set(url, {counts});
    return counts;
  } catch (error) {
    const message = String(error);
    cache.set(url, {error: message});
    throw new Error(message);
  }
}

function extractPdfAnalysisDriveFileId_(url) {
  const text = String(url || '').trim();
  const hyperlinkMatch = text.match(/^=HYPERLINK\("([^"]+)"/i);
  const candidate = hyperlinkMatch ? hyperlinkMatch[1] : text;
  const decoded = decodeURIComponent(candidate);
  const match = decoded.match(/\/d\/([A-Za-z0-9_-]{20,})/) ||
    decoded.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (!match) {
    throw new Error('A Google Drive file ID could not be read from the URL.');
  }
  return match[1];
}

function formatPdfAnalysisCountLog_(counts, key) {
  return counts && Number.isFinite(counts[key]) ? counts[key] : '[BLANK]';
}

/**
 * Rebuilds project-derived CSVs for every eligible PDF Analysis row. This is
 * the manual historical backfill and can be rerun safely.
 */
function syncPostHogSolarTables() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. Solar table sync was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    return syncPostHogSolarTablesForResources_(getOrCreateResources_());
  } finally {
    lock.releaseLock();
  }
}

/**
 * Internal entry point used by syncPostHogProjects() while it already owns
 * the script lock.
 */
function syncPostHogSolarTablesForResources_(resources) {
  const sheet = getOrCreateOpenAIPdfSheet_(resources.spreadsheet);
  const candidates = loadPostHogSolarCandidates_(sheet);
  if (candidates.length === 0) {
    console.log('No eligible PDF Analysis rows require project solar tables.');
    return {rows: 0, matched: 0, notFound: 0, incomplete: 0, errors: 0};
  }
  if (candidates.length > POSTHOG_SOLAR_CONFIG.MAX_ROWS_PER_SYNC) {
    throw new Error(
      `PDF Analysis contains ${candidates.length} eligible rows, exceeding ` +
      `the safety limit of ${POSTHOG_SOLAR_CONFIG.MAX_ROWS_PER_SYNC}.`,
    );
  }

  const records = fetchPostHogSolarRecords_(
    candidates.map((candidate) => candidate.projectId),
  );
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const outputIndex = {
    summary: requireSheetHeaderIndex_(
      headers,
      'Project Summary CSV URL',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    monthly: requireSheetHeaderIndex_(
      headers,
      'Project Monthly CSV URL',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    source: requireSheetHeaderIndex_(
      headers,
      'Project Data Source',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    syncedAt: requireSheetHeaderIndex_(
      headers,
      'Project Data Synced At',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    status: requireSheetHeaderIndex_(
      headers,
      'Project Data Status',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    error: requireSheetHeaderIndex_(
      headers,
      'Project Data Error',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    projectPanelCount: requireSheetHeaderIndex_(
      headers,
      'Project Panel Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
    projectArrayCount: requireSheetHeaderIndex_(
      headers,
      'Project Array Count',
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    ),
  };
  const stats = {
    rows: candidates.length,
    matched: 0,
    matchedFromGoodLeap: 0,
    matchedFromArtemisSales: 0,
    notFound: 0,
    incomplete: 0,
    errors: 0,
  };

  candidates.forEach((candidate) => {
    const row = values[candidate.rowNumber - 1];
    const record = records.get(candidate.projectId);
    const syncedAt = new Date();
    if (!record) {
      stats.notFound += 1;
      setPostHogSolarOutputValues_(row, outputIndex, {
        summaryUrl: '',
        monthlyUrl: '',
        source: '',
        syncedAt,
        status: 'Not Found',
        error: '',
        projectPanelCount: '',
        projectArrayCount: '',
      });
      return;
    }

    try {
      const tables = buildPostHogSolarTables_(record);
      if (tables.summaryRows.length === 0) {
        stats.incomplete += 1;
        setPostHogSolarOutputValues_(row, outputIndex, {
          summaryUrl: '',
          monthlyUrl: '',
          source: record.source,
          syncedAt,
          status: 'Incomplete',
          error: tables.notes.join(' ') || 'No active solar arrays were found.',
          projectPanelCount: 0,
          projectArrayCount: 0,
        });
        return;
      }
      const files = createPostHogSolarCsvFiles_(candidate, tables, resources);
      const incomplete = tables.notes.length > 0;
      if (incomplete) {
        stats.incomplete += 1;
      } else {
        stats.matched += 1;
      }
      if (record.source === 'Artemis Sales') {
        stats.matchedFromArtemisSales += 1;
      } else {
        stats.matchedFromGoodLeap += 1;
      }
      setPostHogSolarOutputValues_(row, outputIndex, {
        summaryUrl: files.summaryUrl,
        monthlyUrl: files.monthlyUrl,
        source: record.source,
        syncedAt,
        status: incomplete ? 'Incomplete' : 'Matched',
        error: tables.notes.join(' '),
        projectPanelCount: tables.panelCount,
        projectArrayCount: tables.arrayCount,
      });
    } catch (error) {
      stats.errors += 1;
      const safeError = truncatePostHogText_(String(error), 1000);
      setPostHogSolarOutputValues_(row, outputIndex, {
        // Preserve the last successful files if a temporary Drive write fails.
        summaryUrl: row[outputIndex.summary] || '',
        monthlyUrl: row[outputIndex.monthly] || '',
        source: row[outputIndex.source] || record.source,
        syncedAt,
        status: 'Error',
        error: safeError,
        projectPanelCount: row[outputIndex.projectPanelCount] || '',
        projectArrayCount: row[outputIndex.projectArrayCount] || '',
      });
      console.error(
        `[PROJECT SOLAR ERROR] ${candidate.projectId} | ${safeError}`,
      );
    }
  });

  if (values.length > 1) {
    sheet
      .getRange(2, 1, values.length - 1, values[0].length)
      .setValues(values.slice(1));
  }
  sheet.getRange('S:S').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  SpreadsheetApp.flush();
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

function getPostHogSolarSettings_() {
  const base = getPostHogSettings_();
  const properties = PropertiesService.getScriptProperties();
  const settings = {
    goodLeapProjectsTable: String(
      properties.getProperty(
        POSTHOG_SOLAR_PROPERTY_KEYS.GOODLEAP_PROJECTS_TABLE,
      ) || POSTHOG_SOLAR_CONFIG.DEFAULT_GOODLEAP_PROJECTS_TABLE,
    ).trim(),
    goodLeapPanelsTable: String(
      properties.getProperty(
        POSTHOG_SOLAR_PROPERTY_KEYS.GOODLEAP_PANELS_TABLE,
      ) || POSTHOG_SOLAR_CONFIG.DEFAULT_GOODLEAP_PANELS_TABLE,
    ).trim(),
    artemisSalesProjectsTable: base.fallbackProjectsTable,
    artemisSalesPanelsTable: String(
      properties.getProperty(
        POSTHOG_SOLAR_PROPERTY_KEYS.ARTEMIS_SALES_PANELS_TABLE,
      ) || POSTHOG_SOLAR_CONFIG.DEFAULT_ARTEMIS_SALES_PANELS_TABLE,
    ).trim(),
    projectIdField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PROJECT_ID_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PROJECT_ID_FIELD,
    ),
    arrayStatsField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.ARRAY_STATS_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_ARRAY_STATS_FIELD,
    ),
    sourceUpdatedAtField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.SOURCE_UPDATED_AT_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_SOURCE_UPDATED_AT_FIELD,
    ),
    panelProjectIdField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PANEL_PROJECT_ID_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PANEL_PROJECT_ID_FIELD,
    ),
    panelSegmentField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PANEL_SEGMENT_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PANEL_SEGMENT_FIELD,
    ),
    panelActiveField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PANEL_ACTIVE_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PANEL_ACTIVE_FIELD,
    ),
    panelAzimuthField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PANEL_AZIMUTH_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PANEL_AZIMUTH_FIELD,
    ),
    panelPitchField: getPostHogSolarProperty_(
      properties,
      POSTHOG_SOLAR_PROPERTY_KEYS.PANEL_PITCH_FIELD,
      POSTHOG_SOLAR_CONFIG.DEFAULT_PANEL_PITCH_FIELD,
    ),
  };

  [
    settings.goodLeapProjectsTable,
    settings.goodLeapPanelsTable,
    settings.artemisSalesProjectsTable,
    settings.artemisSalesPanelsTable,
  ].forEach((identifier) => validatePostHogSolarIdentifier_(identifier, true));
  [
    settings.projectIdField,
    settings.arrayStatsField,
    settings.sourceUpdatedAtField,
    settings.panelProjectIdField,
    settings.panelSegmentField,
    settings.panelActiveField,
    settings.panelAzimuthField,
    settings.panelPitchField,
  ].forEach((identifier) => validatePostHogSolarIdentifier_(identifier, false));
  return settings;
}

function getPostHogSolarProperty_(properties, key, fallback) {
  return String(properties.getProperty(key) || fallback).trim();
}

function validatePostHogSolarIdentifier_(value, allowDots) {
  const pattern = allowDots
    ? /^[A-Za-z_][A-Za-z0-9_.]*$/
    : /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!pattern.test(value)) {
    throw new Error(`Unsafe PostHog solar identifier: ${value}.`);
  }
}

function buildPostHogSolarSources_(settings) {
  return [
    {
      label: 'GoodLeap',
      queryLabel: 'goodleap',
      projectsTable: settings.goodLeapProjectsTable,
      panelsTable: settings.goodLeapPanelsTable,
    },
    {
      label: 'Artemis Sales',
      queryLabel: 'artemis_sales',
      projectsTable: settings.artemisSalesProjectsTable,
      panelsTable: settings.artemisSalesPanelsTable,
    },
  ];
}

function loadPostHogSolarCandidates_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const indexes = {};
  POSTHOG_SOLAR_REQUIRED_HEADERS.forEach((header) => {
    indexes[header] = requireSheetHeaderIndex_(
      headers,
      header,
      POSTHOG_SOLAR_CONFIG.SHEET_NAME,
    );
  });

  return values.slice(1).map((row, offset) => ({
    rowNumber: offset + 2,
    sourceFileId: String(row[indexes['Source Drive File ID']] || '').trim(),
    projectId: String(row[indexes['Project ID']] || '').trim(),
    applicationId: String(row[indexes['Application ID']] || '').trim(),
    sourceFilename: String(row[indexes['Source Filename']] || '').trim(),
    extractionStatus: String(row[indexes['Extraction Status']] || '').trim(),
  })).filter((candidate) =>
    candidate.sourceFileId &&
    isSafePostHogSolarProjectId_(candidate.projectId) &&
    candidate.extractionStatus === 'Extracted'
  );
}

function isSafePostHogSolarProjectId_(projectId) {
  return /^[A-Za-z0-9-]{1,100}$/.test(String(projectId || ''));
}

function fetchPostHogSolarRecords_(projectIds) {
  const uniqueIds = Array.from(new Set(projectIds.filter(Boolean)));
  const settings = getPostHogSolarSettings_();
  const sources = buildPostHogSolarSources_(settings);
  const records = new Map();
  let unresolved = uniqueIds.slice();

  sources.forEach((source) => {
    if (unresolved.length === 0) {
      return;
    }
    const sourceRecords = fetchPostHogSolarSourceRecords_(
      unresolved,
      source,
      settings,
    );
    sourceRecords.forEach((record, projectId) => {
      if (!records.has(projectId)) {
        records.set(projectId, record);
      }
    });
    unresolved = unresolved.filter((projectId) => !records.has(projectId));
  });
  return records;
}

function fetchPostHogSolarSourceRecords_(projectIds, source, settings) {
  const records = new Map();
  chunkPostHogArray_(projectIds, POSTHOG_SOLAR_CONFIG.QUERY_BATCH_SIZE)
    .forEach((batch) => {
      const literals = batch.map(postHogStringLiteral_).join(', ');
      const projectResponse = executePostHogHogQL_(
        [
          'SELECT',
          `  toString(${settings.projectIdField}) AS project_id,`,
          `  toString(${settings.arrayStatsField}) AS array_stats,`,
          `  ${settings.sourceUpdatedAtField} AS source_updated_at`,
          `FROM ${source.projectsTable}`,
          `WHERE toString(${settings.projectIdField}) IN (${literals})`,
          `ORDER BY ${settings.sourceUpdatedAtField} DESC`,
          `LIMIT ${Math.max(batch.length * 2, batch.length)}`,
        ].join('\n'),
        `goodleap_solar_${source.queryLabel}_projects`,
      );
      const projectRows = parsePostHogSolarProjectRows_(
        projectResponse,
        source.label,
      );
      const matchedIds = Array.from(projectRows.keys());
      if (matchedIds.length === 0) {
        return;
      }
      const panelLiterals = matchedIds.map(postHogStringLiteral_).join(', ');
      const panelResponse = executePostHogHogQL_(
        [
          'SELECT',
          // Group by the physical warehouse fields. HogQL/ClickHouse can
          // reject toString(project_id) as a grouping expression even when
          // the selected project_id column is already stored as String.
          `  ${settings.panelProjectIdField} AS project_id,`,
          `  ${settings.panelSegmentField} AS segment_index,`,
          '  count() AS panel_count,',
          `  avg(${settings.panelAzimuthField}) AS azimuth,`,
          `  avg(${settings.panelPitchField}) AS pitch`,
          `FROM ${source.panelsTable}`,
          `WHERE toString(${settings.panelProjectIdField}) IN (${panelLiterals})`,
          `  AND ${settings.panelActiveField} = true`,
          `GROUP BY ${settings.panelProjectIdField}, ` +
            `${settings.panelSegmentField}`,
          `ORDER BY ${settings.panelProjectIdField}, ` +
            `${settings.panelSegmentField}`,
          `LIMIT ${POSTHOG_SOLAR_CONFIG.MAX_PANEL_GROUPS_PER_BATCH}`,
        ].join('\n'),
        `goodleap_solar_${source.queryLabel}_panels`,
      );
      const panelsByProject = parsePostHogSolarPanelRows_(panelResponse);
      projectRows.forEach((record, projectId) => {
        record.panelGroups = panelsByProject.get(projectId) || new Map();
        records.set(projectId, record);
      });
    });
  return records;
}

function parsePostHogSolarProjectRows_(response, source) {
  requirePostHogSolarColumns_(
    response,
    ['project_id', 'array_stats', 'source_updated_at'],
    `${source} projects`,
  );
  const index = buildPostHogSolarColumnIndex_(response.columns);
  const rows = new Map();
  response.results.forEach((row) => {
    const projectId = String(row[index.project_id] || '').trim();
    if (!projectId || rows.has(projectId)) {
      return;
    }
    const arrayStats = parsePostHogSolarJson_(row[index.array_stats]);
    if (!arrayStats || Object.keys(arrayStats).length === 0) {
      return;
    }
    rows.set(projectId, {
      projectId,
      source,
      sourceUpdatedAt: parsePostHogDate_(row[index.source_updated_at]),
      arrayStats,
      panelGroups: new Map(),
    });
  });
  return rows;
}

function parsePostHogSolarPanelRows_(response) {
  requirePostHogSolarColumns_(
    response,
    ['project_id', 'segment_index', 'panel_count', 'azimuth', 'pitch'],
    'solar panels',
  );
  const index = buildPostHogSolarColumnIndex_(response.columns);
  const groups = new Map();
  response.results.forEach((row) => {
    const projectId = String(row[index.project_id] || '').trim();
    const segment = String(row[index.segment_index]);
    if (!projectId || !segment) {
      return;
    }
    if (!groups.has(projectId)) {
      groups.set(projectId, new Map());
    }
    groups.get(projectId).set(segment, {
      panelCount: Number(row[index.panel_count] || 0),
      azimuth: Number(row[index.azimuth]),
      pitch: Number(row[index.pitch]),
    });
  });
  return groups;
}

function requirePostHogSolarColumns_(response, required, label) {
  const normalized = response.columns.map((column) =>
    String(column).toLowerCase(),
  );
  const missing = required.filter((column) => !normalized.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `${label} query is missing columns: ${missing.join(', ')}. ` +
      `Returned: ${response.columns.join(', ')}.`,
    );
  }
}

function buildPostHogSolarColumnIndex_(columns) {
  const index = {};
  columns.forEach((column, offset) => {
    index[String(column).toLowerCase()] = offset;
  });
  return index;
}

function parsePostHogSolarJson_(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Project array_stats is not valid JSON.');
  }
}

function buildPostHogSolarTables_(record) {
  const statsKeys = Object.keys(record.arrayStats || {})
    .sort(comparePostHogSolarArrayIds_);
  const activePanelKeys = Array.from(record.panelGroups.keys())
    .sort(comparePostHogSolarArrayIds_);
  const exportKeys = activePanelKeys.length > 0
    ? activePanelKeys.filter((key) => record.arrayStats[key])
    : statsKeys;
  const notes = [];

  activePanelKeys.forEach((key) => {
    if (!record.arrayStats[key]) {
      notes.push(`Active segment ${key} is missing from array_stats.`);
    }
  });
  if (activePanelKeys.length === 0) {
    notes.push('No active solar panel groups were returned; panel counts are blank.');
  }

  const summaryRows = exportKeys.map((key) => {
    const stat = record.arrayStats[key] || {};
    const panels = record.panelGroups.get(key) || {};
    return {
      arrayId: key,
      panelCount: Number.isFinite(panels.panelCount) ? panels.panelCount : null,
      azimuth: Number.isFinite(panels.azimuth) ? panels.azimuth : stat.azimuth,
      pitch: Number.isFinite(panels.pitch) ? panels.pitch : stat.tilt,
      annualTof: toPostHogSolarPercent_(stat.tiltOrientationFactor),
      annualSolarAccess: toPostHogSolarPercent_(stat.solarAccessValue),
      annualTsrf: toPostHogSolarPercent_(stat.totalSolarResourceFraction),
    };
  });
  const monthlyRows = exportKeys.map((key) => {
    const stat = record.arrayStats[key] || {};
    const months = Array.isArray(stat.monthlySolarAccessValue)
      ? stat.monthlySolarAccessValue
      : [];
    if (months.length !== 12) {
      notes.push(`Segment ${key} has ${months.length} monthly values instead of 12.`);
    }
    return {
      arrayId: key,
      months: Array.from({length: 12}, (_, index) =>
        toPostHogSolarPercent_(months[index]),
      ),
    };
  });
  const weighted = calculatePostHogSolarWeightedAverages_(summaryRows);
  const panelCount = summaryRows.reduce(
    (sum, row) => sum + Math.max(Number(row.panelCount) || 0, 0),
    0,
  );
  return {
    summaryRows,
    monthlyRows,
    weighted,
    panelCount,
    arrayCount: summaryRows.length,
    notes: Array.from(new Set(notes)),
  };
}

function comparePostHogSolarArrayIds_(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

function toPostHogSolarPercent_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
}

function calculatePostHogSolarWeightedAverages_(rows) {
  const valid = rows.filter((row) =>
    Number(row.panelCount) > 0 &&
    Number.isFinite(row.annualSolarAccess) &&
    Number.isFinite(row.annualTsrf),
  );
  const totalPanels = valid.reduce(
    (sum, row) => sum + Number(row.panelCount),
    0,
  );
  if (totalPanels === 0) {
    return {annualSolarAccess: null, annualTsrf: null};
  }
  return {
    annualSolarAccess: valid.reduce(
      (sum, row) => sum + row.annualSolarAccess * Number(row.panelCount),
      0,
    ) / totalPanels,
    annualTsrf: valid.reduce(
      (sum, row) => sum + row.annualTsrf * Number(row.panelCount),
      0,
    ) / totalPanels,
  };
}

function createPostHogSolarCsvFiles_(candidate, tables, resources) {
  const sourceFile = DriveApp.getFileById(candidate.sourceFileId);
  const parents = sourceFile.getParents();
  const folder = parents.hasNext() ? parents.next() : resources.rootFolder;
  const baseName = sanitizeFileName_(
    `${candidate.applicationId}_${candidate.projectId}`,
  );
  const summaryFile = createOrUpdatePostHogSolarCsvFile_(
    folder,
    `${baseName}_project_summary.csv`,
    buildPostHogSolarSummaryCsv_(tables),
  );
  const monthlyFile = createOrUpdatePostHogSolarCsvFile_(
    folder,
    `${baseName}_project_monthly_solar_access.csv`,
    buildPostHogSolarMonthlyCsv_(tables),
  );
  return {summaryUrl: summaryFile.getUrl(), monthlyUrl: monthlyFile.getUrl()};
}

function buildPostHogSolarSummaryCsv_(tables) {
  const rows = [[
    'Array ID',
    'Panel Count',
    'Azimuth',
    'Pitch',
    'Annual TOF',
    'Annual Solar Access',
    'Annual TSRF',
  ]];
  tables.summaryRows.forEach((row) => {
    rows.push([
      row.arrayId,
      formatPostHogSolarNumber_(row.panelCount, ''),
      formatPostHogSolarNumber_(row.azimuth, '°'),
      formatPostHogSolarNumber_(row.pitch, '°'),
      formatPostHogSolarNumber_(row.annualTof, '%'),
      formatPostHogSolarNumber_(row.annualSolarAccess, '%'),
      formatPostHogSolarNumber_(row.annualTsrf, '%'),
    ]);
  });
  rows.push([
    'Weighted Average by Panel Count',
    '', '', '', '',
    formatPostHogSolarNumber_(tables.weighted.annualSolarAccess, '%'),
    formatPostHogSolarNumber_(tables.weighted.annualTsrf, '%'),
  ]);
  return rows.map((row) => row.map(escapePostHogSolarCsvCell_).join(','))
    .join('\r\n');
}

function buildPostHogSolarMonthlyCsv_(tables) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const rows = [['Array ID'].concat(months)];
  tables.monthlyRows.forEach((row) => {
    rows.push([row.arrayId].concat(
      row.months.map((value) => formatPostHogSolarNumber_(value, '')),
    ));
  });
  return rows.map((row) => row.map(escapePostHogSolarCsvCell_).join(','))
    .join('\r\n');
}

function formatPostHogSolarNumber_(value, suffix) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  const rounded = Number(numeric.toFixed(4));
  return `${rounded}${suffix || ''}`;
}

function escapePostHogSolarCsvCell_(value) {
  let text = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createOrUpdatePostHogSolarCsvFile_(folder, name, content) {
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    return existing.next().setContent(content);
  }
  return folder.createFile(name, content, 'text/csv');
}

function setPostHogSolarOutputValues_(row, index, output) {
  row[index.summary] = safeCellValue_(output.summaryUrl || '');
  row[index.monthly] = safeCellValue_(output.monthlyUrl || '');
  row[index.source] = safeCellValue_(output.source || '');
  row[index.syncedAt] = output.syncedAt || new Date();
  row[index.status] = safeCellValue_(output.status || '');
  row[index.error] = safeCellValue_(output.error || '');
  row[index.projectPanelCount] = safeCellValue_(output.projectPanelCount);
  row[index.projectArrayCount] = safeCellValue_(output.projectArrayCount);
}

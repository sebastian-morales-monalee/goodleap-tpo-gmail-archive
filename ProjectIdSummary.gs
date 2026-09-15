/**
 * GoodLeap TPO - Project ID operational summary
 *
 * This file belongs in the SAME Apps Script project as the other workflow
 * files. It maintains one row per resolved Project ID by combining the
 * authoritative URL in PostHog Projects with email, attachment, PDF, and map
 * metadata from the archive sheets and PostHog. It does not call Gmail,
 * OpenAI, or Drive APIs.
 */

const PROJECT_ID_SUMMARY_CONFIG = {
  SHEET_NAME: 'Project ID Summary',
  PROJECTS_SHEET_NAME: 'PostHog Projects',
  AI_SHEET_NAME: 'AI Analysis',
  PDF_SHEET_NAME: 'PDF Analysis',
  ATTACHMENTS_SHEET_NAME: 'Attachments',
  HEADER_BACKGROUND: '#7200c9',
  HEADER_FONT_COLOR: '#ffffff',
  TAB_COLOR: '#7200c9',
  DATE_FORMAT: 'yyyy-mm-dd hh:mm:ss',
  MAP_QUERY_BATCH_SIZE: 100,
  MAX_PROJECT_IDS_PER_SYNC: 5000,
  MAP_PREVIEW_LIMIT: 10,
  PRODUCTION_CATEGORY: 'Production',
  PRODUCTION_GROUP_LABEL: 'Production with other categories',
  OTHER_CATEGORIES_GROUP_LABEL: 'Other Categories without Production',
};

const PROJECT_ID_SUMMARY_HEADERS = [
  'Project ID',
  'Project URL',
  'Email Count',
  'Attachment Count',
  'Analyzed PDF Count',
  'First Email Received At',
  'Last Email Received At',
  'Map Data Source',
  'RGB Basemap URL',
  'Production Category Group',
];

const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V1 = [
  'Project ID',
  'Project URL',
  'Email Count',
  'Attachment Count',
  'Analyzed PDF Count',
  'First Email Received At',
  'Last Email Received At',
];

const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V2 = [
  'Project ID',
  'Project URL',
  'Email Count',
  'Attachment Count',
  'Analyzed PDF Count',
  'First Email Received At',
  'Last Email Received At',
  'Map Data Source',
  'RGB Basemap URL',
];

/**
 * Creates or upgrades Project ID Summary and immediately populates it.
 * It is safe to run repeatedly and never creates duplicate project rows.
 */
function setupProjectIdSummary() {
  const result = refreshProjectIdSummary();
  console.log('Project ID Summary setup completed.');
  return result;
}

/**
 * Reads a small sample of Project IDs from both map-source tables without
 * writing the destination sheet.
 */
function previewProjectIdSummaryMapData() {
  const resources = getOrCreateResources_();
  const projects = loadProjectIdSummaryBaseProjects_(resources.spreadsheet)
    .slice(0, PROJECT_ID_SUMMARY_CONFIG.MAP_PREVIEW_LIMIT);
  const lookup = fetchProjectIdSummaryMapData_(
    projects.map((project) => project.projectId),
  );
  const preview = projects.map((project) => {
    const mapData = lookup.byProjectId.get(project.key) || {};
    return {
      projectId: project.projectId,
      lookupSource: mapData.lookupSource || '',
      mapDataSource: mapData.mapDataSource || '',
      rgbBasemapUrl: mapData.rgbBasemapUrl || '',
    };
  });
  const result = {
    projectsPreviewed: projects.length,
    foundInGoodLeap: lookup.foundInGoodLeap,
    foundInArtemisSales: lookup.foundInArtemisSales,
    notFound: lookup.notFound,
    errors: lookup.errors.length,
    preview,
  };
  console.log(JSON.stringify(result, null, 2));
  console.log('Preview completed without writing Project ID Summary.');
  return result;
}

/**
 * Calculates the complete summary without writing the destination sheet.
 */
function previewProjectIdSummary() {
  const resources = getOrCreateResources_();
  const summary = buildProjectIdSummary_(resources.spreadsheet, {
    refreshMapData: true,
  });
  const result = buildProjectIdSummaryStats_(summary);
  result.preview = summary.rows.slice(0, 10).map((row) => ({
    projectId: row[0],
    projectUrl: row[1],
    emailCount: row[2],
    attachmentCount: row[3],
    analyzedPdfCount: row[4],
    firstEmailReceivedAt: row[5] || '',
    lastEmailReceivedAt: row[6] || '',
    mapDataSource: row[7] || '',
    rgbBasemapUrl: row[8] || '',
    productionCategoryGroup: row[9] || '',
  }));
  console.log(JSON.stringify(result, null, 2));
  console.log('Preview completed without writing Project ID Summary.');
  return result;
}

/**
 * Rebuilds Project ID Summary from the current source sheets.
 */
function refreshProjectIdSummary() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. Project summary refresh was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }

  try {
    const resources = getOrCreateResources_();
    const result = refreshProjectIdSummaryForSpreadsheet_(
      resources.spreadsheet,
      {refreshMapData: true},
    );
    SpreadsheetApp.flush();
    console.log(JSON.stringify(result, null, 2));
    console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Best-effort wrapper for existing automatic workflows. Summary failures are
 * logged but never block email, PDF, or PostHog processing.
 */
function refreshProjectIdSummarySafely_(spreadsheet, options) {
  try {
    return refreshProjectIdSummaryForSpreadsheet_(spreadsheet, options);
  } catch (error) {
    const message = String(error).slice(0, 1000);
    console.error(`Project ID Summary refresh failed safely: ${message}`);
    return {updated: false, error: message};
  }
}

function refreshProjectIdSummaryForSpreadsheet_(spreadsheet, options) {
  const sheet = getOrCreateProjectIdSummarySheet_(spreadsheet);
  const existingMapData = loadExistingProjectIdSummaryMapData_(sheet);
  const summary = buildProjectIdSummary_(spreadsheet, {
    refreshMapData: Boolean(options && options.refreshMapData),
    existingMapData,
  });
  const existingRows = loadExistingProjectIdSummaryRows_(sheet);
  const unchanged = projectIdSummaryRowsEqual_(existingRows, summary.rows);

  if (!unchanged) {
    rewriteProjectIdSummaryRows_(sheet, summary.rows);
  }

  const result = buildProjectIdSummaryStats_(summary);
  result.sheet = PROJECT_ID_SUMMARY_CONFIG.SHEET_NAME;
  result.updated = !unchanged;
  result.unchanged = unchanged;
  return result;
}

function buildProjectIdSummary_(spreadsheet, options) {
  const projects = loadProjectIdSummaryBaseProjects_(spreadsheet);
  const emailMetrics = loadProjectIdSummaryEmailMetrics_(spreadsheet);
  const pdfCounts = loadProjectIdSummaryProjectCounts_(
    spreadsheet,
    PROJECT_ID_SUMMARY_CONFIG.PDF_SHEET_NAME,
  );
  const attachmentCounts = loadProjectIdSummaryAttachmentCounts_(spreadsheet);
  const existingMapData = options && options.existingMapData
    ? options.existingMapData
    : new Map();
  const pendingMapProjectIds = projects
    .filter((project) => {
      const existing = existingMapData.get(project.key);
      return !existing || !existing.mapDataSource || !existing.rgbBasemapUrl;
    })
    .map((project) => project.projectId);
  const mapLookup = options && options.refreshMapData
    ? fetchProjectIdSummaryMapData_(
      pendingMapProjectIds,
    )
    : emptyProjectIdSummaryMapLookup_();
  const rows = [];
  let projectsWithoutEmails = 0;
  let projectsWithoutPdfs = 0;
  let projectsWithoutAttachments = 0;

  projects.forEach((project) => {
    const email = emailMetrics.get(project.key) || {
      count: 0,
      categorizedCount: 0,
      hasProduction: false,
      firstReceivedAt: '',
      lastReceivedAt: '',
    };
    const pdfCount = pdfCounts.get(project.key) || 0;
    let attachmentCount = 0;
    project.applicationIds.forEach((applicationId) => {
      attachmentCount += attachmentCounts.get(applicationId) || 0;
    });

    if (email.count === 0) projectsWithoutEmails += 1;
    if (pdfCount === 0) projectsWithoutPdfs += 1;
    if (attachmentCount === 0) projectsWithoutAttachments += 1;

    const refreshedMapData = mapLookup.byProjectId.get(project.key);
    const mapData = refreshedMapData || existingMapData.get(project.key) || {};

    rows.push([
      project.projectId,
      project.projectUrl,
      email.count,
      attachmentCount,
      pdfCount,
      email.firstReceivedAt,
      email.lastReceivedAt,
      mapData.mapDataSource || '',
      mapData.rgbBasemapUrl || '',
      getProjectIdSummaryCategoryGroup_(email),
    ]);
  });

  rows.sort((left, right) => {
    const emailDifference = Number(right[2]) - Number(left[2]);
    if (emailDifference !== 0) return emailDifference;
    const rightTime = projectIdSummaryDateTime_(right[6]);
    const leftTime = projectIdSummaryDateTime_(left[6]);
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left[0]).localeCompare(String(right[0]));
  });

  return {
    rows,
    projectsWithoutEmails,
    projectsWithoutPdfs,
    projectsWithoutAttachments,
    sourceProjectCount: projects.length,
    emailRowsWithProjectId: Array.from(emailMetrics.values()).reduce(
      (sum, metric) => sum + metric.count,
      0,
    ),
    categorizedEmailRowsWithProjectId: Array.from(emailMetrics.values()).reduce(
      (sum, metric) => sum + metric.categorizedCount,
      0,
    ),
    pdfRowsWithProjectId: Array.from(pdfCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    ),
    mapLookup,
  };
}

function buildProjectIdSummaryStats_(summary) {
  return {
    uniqueProjects: summary.rows.length,
    emailRowsWithProjectId: summary.emailRowsWithProjectId,
    categorizedEmailRowsWithProjectId:
      summary.categorizedEmailRowsWithProjectId,
    pdfRowsWithProjectId: summary.pdfRowsWithProjectId,
    projectsWithoutEmails: summary.projectsWithoutEmails,
    projectsWithoutPdfs: summary.projectsWithoutPdfs,
    projectsWithoutAttachments: summary.projectsWithoutAttachments,
    projectsWithMapDataSource: summary.rows.filter((row) => row[7]).length,
    projectsWithRgbBasemapUrl: summary.rows.filter((row) => row[8]).length,
    projectsWithProduction: summary.rows.filter(
      (row) => row[9] === PROJECT_ID_SUMMARY_CONFIG.PRODUCTION_GROUP_LABEL,
    ).length,
    projectsWithoutProduction: summary.rows.filter(
      (row) =>
        row[9] === PROJECT_ID_SUMMARY_CONFIG.OTHER_CATEGORIES_GROUP_LABEL,
    ).length,
    projectsWithoutCategoryGroup: summary.rows.filter((row) => !row[9]).length,
    mapFoundInGoodLeap: summary.mapLookup.foundInGoodLeap,
    mapFoundInArtemisSales: summary.mapLookup.foundInArtemisSales,
    mapNotFound: summary.mapLookup.notFound,
    mapQueryErrors: summary.mapLookup.errors.length,
  };
}

function emptyProjectIdSummaryMapLookup_() {
  return {
    byProjectId: new Map(),
    foundInGoodLeap: 0,
    foundInArtemisSales: 0,
    notFound: 0,
    errors: [],
  };
}

function fetchProjectIdSummaryMapData_(projectIds) {
  const uniqueProjectIds = Array.from(new Set(
    projectIds
      .map((projectId) => String(projectId || '').trim().toLowerCase())
      .filter((projectId) => isProjectIdSummaryUuid_(projectId)),
  ));
  if (uniqueProjectIds.length > PROJECT_ID_SUMMARY_CONFIG.MAX_PROJECT_IDS_PER_SYNC) {
    throw new Error(
      `Project ID Summary found ${uniqueProjectIds.length} Project IDs, ` +
      `exceeding the safety limit of ` +
      `${PROJECT_ID_SUMMARY_CONFIG.MAX_PROJECT_IDS_PER_SYNC}.`,
    );
  }
  if (uniqueProjectIds.length === 0) {
    return emptyProjectIdSummaryMapLookup_();
  }

  const settings = getPostHogSettings_();
  const result = emptyProjectIdSummaryMapLookup_();
  chunkPostHogArray_(
    uniqueProjectIds,
    PROJECT_ID_SUMMARY_CONFIG.MAP_QUERY_BATCH_SIZE,
  ).forEach((batch) => {
    try {
      const primary = fetchProjectIdSummaryMapDataFromTable_(
        batch,
        settings.mapSourceTable,
        'GoodLeap',
        settings,
      );
      primary.forEach((mapData, projectId) => {
        result.byProjectId.set(projectId, mapData);
        result.foundInGoodLeap += 1;
      });

      const fallbackIds = batch.filter(
        (projectId) => !primary.has(projectId),
      );
      if (fallbackIds.length > 0) {
        const fallback = fetchProjectIdSummaryMapDataFromTable_(
          fallbackIds,
          settings.fallbackMapSourceTable,
          'Artemis Sales',
          settings,
        );
        fallback.forEach((mapData, projectId) => {
          result.byProjectId.set(projectId, mapData);
          result.foundInArtemisSales += 1;
        });
        result.notFound += fallbackIds.length - fallback.size;
      }
    } catch (error) {
      const safeError = truncatePostHogText_(String(error), 1000);
      result.errors.push({projectIds: batch.slice(), error: safeError});
      console.error(`[PROJECT MAP DATA ERROR] ${safeError}`);
    }
  });
  return result;
}

function fetchProjectIdSummaryMapDataFromTable_(
  projectIds,
  tableName,
  lookupSource,
  settings,
) {
  if (projectIds.length === 0) return new Map();
  const literals = projectIds
    .map((projectId) => postHogStringLiteral_(projectId))
    .join(', ');
  const projectIdExpression =
    `toString(m.${settings.mapSourceProjectIdField})`;
  const query = [
    'SELECT',
    `  ${projectIdExpression} AS project_id,`,
    `  argMax(toString(m.${settings.mapDataSourceField}), ` +
      `m.${settings.mapSourceUpdatedAtField}) AS map_data_source,`,
    `  argMax(toString(m.${settings.rgbBasemapUrlField}), ` +
      `m.${settings.mapSourceUpdatedAtField}) AS rgb_basemap_url`,
    `FROM ${tableName} AS m`,
    `WHERE ${projectIdExpression} IN (${literals})`,
    `GROUP BY ${projectIdExpression}`,
    `ORDER BY ${projectIdExpression}`,
    `LIMIT ${projectIds.length}`,
  ].join('\n');
  const response = executePostHogHogQL_(
    query,
    lookupSource === 'GoodLeap'
      ? 'goodleap_apps_script_project_map_lookup'
      : 'artemis_sales_apps_script_project_map_lookup',
  );
  return parseProjectIdSummaryMapData_(response, lookupSource);
}

function parseProjectIdSummaryMapData_(response, lookupSource) {
  const columns = response.columns.map((column) => String(column).toLowerCase());
  const projectIdIndex = columns.indexOf('project_id');
  const mapDataSourceIndex = columns.indexOf('map_data_source');
  const rgbBasemapUrlIndex = columns.indexOf('rgb_basemap_url');
  if (projectIdIndex < 0 || mapDataSourceIndex < 0 || rgbBasemapUrlIndex < 0) {
    throw new Error(
      `Unexpected PostHog map response columns: ${response.columns.join(', ')}.`,
    );
  }
  const byProjectId = new Map();
  response.results.forEach((row) => {
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (!isProjectIdSummaryUuid_(projectId)) return;
    byProjectId.set(projectId, {
      lookupSource,
      mapDataSource: String(row[mapDataSourceIndex] || '').trim(),
      rgbBasemapUrl: safeProjectIdSummaryUrl_(row[rgbBasemapUrlIndex]),
    });
  });
  return byProjectId;
}

function loadExistingProjectIdSummaryMapData_(sheet) {
  const byProjectId = new Map();
  if (!sheet || sheet.getLastRow() < 2) return byProjectId;
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), PROJECT_ID_SUMMARY_HEADERS.length)
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = headers.indexOf('Project ID');
  const mapDataSourceIndex = headers.indexOf('Map Data Source');
  const rgbBasemapUrlIndex = headers.indexOf('RGB Basemap URL');
  if (projectIdIndex < 0 || mapDataSourceIndex < 0 || rgbBasemapUrlIndex < 0) {
    return byProjectId;
  }
  values.slice(1).forEach((row) => {
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (!isProjectIdSummaryUuid_(projectId)) return;
    byProjectId.set(projectId, {
      mapDataSource: String(row[mapDataSourceIndex] || '').trim(),
      rgbBasemapUrl: safeProjectIdSummaryUrl_(row[rgbBasemapUrlIndex]),
    });
  });
  return byProjectId;
}

function loadProjectIdSummaryBaseProjects_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    PROJECT_ID_SUMMARY_CONFIG.PROJECTS_SHEET_NAME,
  );
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error(
      'PostHog Projects is missing or empty. Run syncPostHogProjects() first.',
    );
  }

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Project ID',
    sheet.getName(),
  );
  const projectUrlIndex = requireProjectIdSummaryHeader_(
    headers,
    'Project URL',
    sheet.getName(),
  );
  const applicationIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Application ID',
    sheet.getName(),
  );
  const projectsById = new Map();

  values.slice(1).forEach((row) => {
    const applicationId = String(row[applicationIdIndex] || '').trim();
    const projectIds = splitProjectIdSummaryIds_(row[projectIdIndex]);
    const projectUrls = splitProjectIdSummaryLines_(row[projectUrlIndex]);

    projectIds.forEach((projectId, index) => {
      const key = projectId.toLowerCase();
      const matchingUrl = projectUrls.find(
        (url) => url.toLowerCase().indexOf(key) !== -1,
      );
      const projectUrl = matchingUrl || projectUrls[index] || '';
      let project = projectsById.get(key);
      if (!project) {
        project = {
          key,
          projectId,
          projectUrl,
          applicationIds: new Set(),
        };
        projectsById.set(key, project);
      } else if (!project.projectUrl && projectUrl) {
        project.projectUrl = projectUrl;
      }
      if (applicationId) project.applicationIds.add(applicationId);
    });
  });

  return Array.from(projectsById.values());
}

function loadProjectIdSummaryEmailMetrics_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    PROJECT_ID_SUMMARY_CONFIG.AI_SHEET_NAME,
  );
  const metrics = new Map();
  if (!sheet || sheet.getLastRow() < 2) return metrics;

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Project ID',
    sheet.getName(),
  );
  const receivedAtIndex = requireProjectIdSummaryHeader_(
    headers,
    'Email Received At',
    sheet.getName(),
  );
  const primaryCategoryIndex = requireProjectIdSummaryHeader_(
    headers,
    'Primary Category',
    sheet.getName(),
  );
  const categoriesIndex = requireProjectIdSummaryHeader_(
    headers,
    'Categories',
    sheet.getName(),
  );

  values.slice(1).forEach((row) => {
    const projectIds = splitProjectIdSummaryIds_(row[projectIdIndex]);
    const receivedAt = normalizeProjectIdSummaryDate_(row[receivedAtIndex]);
    const primaryCategory = String(row[primaryCategoryIndex] || '').trim();
    const isCategorized = Boolean(primaryCategory);
    const includesProduction = isCategorized &&
      projectIdSummaryCategoriesIncludeProduction_(row[categoriesIndex]);
    projectIds.forEach((projectId) => {
      const key = projectId.toLowerCase();
      const metric = metrics.get(key) || {
        count: 0,
        categorizedCount: 0,
        hasProduction: false,
        firstReceivedAt: '',
        lastReceivedAt: '',
      };
      metric.count += 1;
      if (isCategorized) {
        metric.categorizedCount += 1;
        metric.hasProduction = metric.hasProduction || includesProduction;
      }
      if (receivedAt) {
        if (
          !metric.firstReceivedAt ||
          receivedAt.getTime() < metric.firstReceivedAt.getTime()
        ) {
          metric.firstReceivedAt = receivedAt;
        }
        if (
          !metric.lastReceivedAt ||
          receivedAt.getTime() > metric.lastReceivedAt.getTime()
        ) {
          metric.lastReceivedAt = receivedAt;
        }
      }
      metrics.set(key, metric);
    });
  });
  return metrics;
}

function getProjectIdSummaryCategoryGroup_(emailMetric) {
  if (!emailMetric || Number(emailMetric.categorizedCount || 0) === 0) {
    return '';
  }
  return emailMetric.hasProduction
    ? PROJECT_ID_SUMMARY_CONFIG.PRODUCTION_GROUP_LABEL
    : PROJECT_ID_SUMMARY_CONFIG.OTHER_CATEGORIES_GROUP_LABEL;
}

/** Uses the same exact multi-value matching rule as AI Dashboard. */
function projectIdSummaryCategoriesIncludeProduction_(value) {
  if (typeof doesAIAnalysisCategoriesIncludeProduction_ === 'function') {
    return doesAIAnalysisCategoriesIncludeProduction_(value);
  }
  return String(value || '')
    .split(/[\r\n,;|]+/)
    .map((category) =>
      category
        .trim()
        .replace(/^[-*\u2022]\s*/, '')
        .replace(/^["'\[]+|["'\]]+$/g, '')
        .trim()
        .toLowerCase(),
    )
    .includes(PROJECT_ID_SUMMARY_CONFIG.PRODUCTION_CATEGORY.toLowerCase());
}

function loadProjectIdSummaryProjectCounts_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  const counts = new Map();
  if (!sheet || sheet.getLastRow() < 2) return counts;

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Project ID',
    sheet.getName(),
  );
  values.slice(1).forEach((row) => {
    splitProjectIdSummaryIds_(row[projectIdIndex]).forEach((projectId) => {
      const key = projectId.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return counts;
}

function loadProjectIdSummaryAttachmentCounts_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    PROJECT_ID_SUMMARY_CONFIG.ATTACHMENTS_SHEET_NAME,
  );
  const counts = new Map();
  if (!sheet || sheet.getLastRow() < 2) return counts;

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const applicationIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Case ID',
    sheet.getName(),
  );
  values.slice(1).forEach((row) => {
    const applicationId = String(row[applicationIdIndex] || '').trim();
    if (!applicationId) return;
    counts.set(applicationId, (counts.get(applicationId) || 0) + 1);
  });
  return counts;
}

function getOrCreateProjectIdSummarySheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(
    PROJECT_ID_SUMMARY_CONFIG.SHEET_NAME,
  );
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PROJECT_ID_SUMMARY_CONFIG.SHEET_NAME);
  }
  if (sheet.getMaxColumns() < PROJECT_ID_SUMMARY_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      PROJECT_ID_SUMMARY_HEADERS.length - sheet.getMaxColumns(),
    );
  }

  const currentHeaders = sheet.getLastRow() > 0
    ? sheet
        .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
        .getDisplayValues()[0]
        .map((value) => String(value).trim())
    : [];
  const hasUnexpectedContent = currentHeaders.some(Boolean) &&
    !projectIdSummaryHeadersMatch_(currentHeaders, PROJECT_ID_SUMMARY_HEADERS) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V2,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V1,
    );
  if (hasUnexpectedContent) {
    throw new Error(
      'Project ID Summary already exists with an unexpected schema. ' +
      'Rename or review that sheet before setup so no data is overwritten.',
    );
  }

  if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V1,
    )
  ) {
    console.log(
      'Project ID Summary schema upgraded: Map Data Source, RGB Basemap URL, ' +
      'and Production Category Group were appended.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V2,
    )
  ) {
    console.log(
      'Project ID Summary schema upgraded: Production Category Group was appended.',
    );
  }

  sheet
    .getRange(1, 1, 1, PROJECT_ID_SUMMARY_HEADERS.length)
    .setValues([PROJECT_ID_SUMMARY_HEADERS])
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.HEADER_BACKGROUND)
    .setFontColor(PROJECT_ID_SUMMARY_CONFIG.HEADER_FONT_COLOR)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setTabColor(PROJECT_ID_SUMMARY_CONFIG.TAB_COLOR);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 520);
  sheet.setColumnWidths(3, 3, 135);
  sheet.setColumnWidths(6, 2, 180);
  sheet.setColumnWidth(8, 180);
  sheet.setColumnWidth(9, 520);
  sheet.setColumnWidth(10, 260);
  return sheet;
}

function projectIdSummaryHeadersMatch_(currentHeaders, expectedHeaders) {
  if (currentHeaders.length < expectedHeaders.length) return false;
  if (!expectedHeaders.every(
    (header, index) => currentHeaders[index] === header,
  )) return false;
  return currentHeaders.slice(expectedHeaders.length).every((header) => !header);
}

function loadExistingProjectIdSummaryRows_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      PROJECT_ID_SUMMARY_HEADERS.length,
    )
    .getValues();
}

function rewriteProjectIdSummaryRows_(sheet, rows) {
  const existingDataRows = Math.max(0, sheet.getLastRow() - 1);
  if (existingDataRows > 0) {
    sheet
      .getRange(2, 1, existingDataRows, PROJECT_ID_SUMMARY_HEADERS.length)
      .clearContent();
  }
  if (rows.length === 0) return;

  const requiredLastRow = rows.length + 1;
  if (sheet.getMaxRows() < requiredLastRow) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      requiredLastRow - sheet.getMaxRows(),
    );
  }

  const range = sheet.getRange(
    2,
    1,
    rows.length,
    PROJECT_ID_SUMMARY_HEADERS.length,
  );
  range.setValues(rows).setVerticalAlignment('middle');
  sheet.getRange(2, 3, rows.length, 3).setNumberFormat('#,##0');
  sheet
    .getRange(2, 6, rows.length, 2)
    .setNumberFormat(PROJECT_ID_SUMMARY_CONFIG.DATE_FORMAT);
  sheet.getRange(2, 1, rows.length, 2).setWrap(false);
  sheet.getRange(2, 8, rows.length, 2).setWrap(false);
  sheet.getRange(2, 10, rows.length, 1).setWrap(false);

  const richUrls = rows.map((row) => {
    const url = String(row[1] || '').trim();
    const builder = SpreadsheetApp.newRichTextValue().setText(url);
    if (url) builder.setLinkUrl(url);
    return [builder.build()];
  });
  sheet.getRange(2, 2, rows.length, 1).setRichTextValues(richUrls);

  const richBasemapUrls = rows.map((row) => {
    const url = safeProjectIdSummaryUrl_(row[8]);
    const builder = SpreadsheetApp.newRichTextValue().setText(url);
    if (url) builder.setLinkUrl(url);
    return [builder.build()];
  });
  sheet.getRange(2, 9, rows.length, 1).setRichTextValues(richBasemapUrls);
}

function projectIdSummaryRowsEqual_(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  for (let rowIndex = 0; rowIndex < leftRows.length; rowIndex += 1) {
    for (
      let columnIndex = 0;
      columnIndex < PROJECT_ID_SUMMARY_HEADERS.length;
      columnIndex += 1
    ) {
      if (
        normalizeProjectIdSummaryComparable_(leftRows[rowIndex][columnIndex]) !==
        normalizeProjectIdSummaryComparable_(rightRows[rowIndex][columnIndex])
      ) {
        return false;
      }
    }
  }
  return true;
}

function normalizeProjectIdSummaryComparable_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `date:${value.getTime()}`;
  }
  return `${typeof value}:${String(value == null ? '' : value)}`;
}

function normalizeProjectIdSummaryDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed;
}

function projectIdSummaryDateTime_(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.getTime()
    : 0;
}

function splitProjectIdSummaryIds_(value) {
  const unique = new Set();
  splitProjectIdSummaryLines_(value).forEach((candidate) => {
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(candidate)
    ) {
      unique.add(candidate.toLowerCase());
    }
  });
  return Array.from(unique);
}

function isProjectIdSummaryUuid_(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

function safeProjectIdSummaryUrl_(value) {
  const url = String(value || '').trim();
  return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
}

function splitProjectIdSummaryLines_(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireProjectIdSummaryHeader_(headers, header, sheetName) {
  const index = headers.indexOf(header);
  if (index === -1) {
    throw new Error(`${sheetName} is missing the required ${header} header.`);
  }
  return index;
}

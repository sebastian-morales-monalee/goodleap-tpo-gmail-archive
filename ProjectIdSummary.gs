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
  COMPARISON_SHEET_NAME: 'Shade Reports Comparison',
  STATE_REGIONS_SHEET_NAME: 'US State Regions',
  COMPARISON_MATCH_TYPE: 'Recalculated Weighted Average',
  HEADER_BACKGROUND: '#7200c9',
  HEADER_FONT_COLOR: '#ffffff',
  DELTA_HEADER_BACKGROUND: '#b45f06',
  DELTA_DATA_BACKGROUND: '#fff2cc',
  ABSOLUTE_DELTA_HEADER_BACKGROUND: '#7f6000',
  ABSOLUTE_DELTA_DATA_BACKGROUND: '#f9cb9c',
  LATEST_AI_DATA_BACKGROUND: '#ffffff',
  PROJECT_METADATA_HEADER_BACKGROUND: '#38761d',
  PROJECT_METADATA_DATA_BACKGROUND: '#e2f0d9',
  TAB_COLOR: '#7200c9',
  DATE_FORMAT: 'yyyy-mm-dd hh:mm:ss',
  MAP_QUERY_BATCH_SIZE: 100,
  MAX_PROJECT_IDS_PER_SYNC: 5000,
  MAP_PREVIEW_LIMIT: 10,
  PRODUCTION_CATEGORY: 'Production',
  PRODUCTION_GROUP_LABEL: 'Production with other categories',
  OTHER_CATEGORIES_GROUP_LABEL: 'Other Categories without Production',
  PROJECT_ENGINE_VERSION_FIELD: 'production_engine_version',
  PROJECT_CREATED_AT_FIELD: 'created_at',
  PROJECT_UPDATED_AT_FIELD: 'updated_at',
  PROJECT_LAST_STATUS_UPDATED_AT_FIELD: 'last_status_updated_at',
  PROJECT_DESIGN_UPDATED_AT_FIELD: 'design_updated_at',
};

const PROJECT_ID_SUMMARY_STATE_REGIONS = [
  ['AL', 'South'],
  ['AK', 'Alaska'],
  ['AZ', 'West'],
  ['AR', 'South'],
  ['CA', 'West'],
  ['CO', 'West'],
  ['CT', 'Northeast'],
  ['DE', 'South'],
  ['DC', 'South'],
  ['FL', 'South'],
  ['GA', 'South'],
  ['HI', 'Hawaii'],
  ['ID', 'West'],
  ['IL', 'Midwest'],
  ['IN', 'Midwest'],
  ['IA', 'Midwest'],
  ['KS', 'Midwest'],
  ['KY', 'South'],
  ['LA', 'South'],
  ['ME', 'Northeast'],
  ['MD', 'South'],
  ['MA', 'Northeast'],
  ['MI', 'Midwest'],
  ['MN', 'Midwest'],
  ['MS', 'South'],
  ['MO', 'Midwest'],
  ['MT', 'West'],
  ['NE', 'Midwest'],
  ['NV', 'West'],
  ['NH', 'Northeast'],
  ['NJ', 'Northeast'],
  ['NM', 'West'],
  ['NY', 'Northeast'],
  ['NC', 'South'],
  ['ND', 'Midwest'],
  ['OH', 'Midwest'],
  ['OK', 'South'],
  ['OR', 'West'],
  ['PA', 'Northeast'],
  ['PR', 'Puerto Rico'],
  ['RI', 'Northeast'],
  ['SC', 'South'],
  ['SD', 'Midwest'],
  ['TN', 'South'],
  ['TX', 'South'],
  ['UT', 'West'],
  ['VT', 'Northeast'],
  ['VA', 'South'],
  ['WA', 'West'],
  ['WV', 'South'],
  ['WI', 'Midwest'],
  ['WY', 'West'],
];

const PROJECT_ID_SUMMARY_COMPARISON_DELTA_HEADERS = [
  'Delta Panel Count',
  'Delta Azimuth',
  'Delta Pitch',
  'Delta Annual TOF (pp)',
  'Delta Annual Solar Access (pp)',
  'Delta Annual TSRF (pp)',
  'Delta Jan (pp)',
  'Delta Feb (pp)',
  'Delta Mar (pp)',
  'Delta Apr (pp)',
  'Delta May (pp)',
  'Delta Jun (pp)',
  'Delta Jul (pp)',
  'Delta Aug (pp)',
  'Delta Sep (pp)',
  'Delta Oct (pp)',
  'Delta Nov (pp)',
  'Delta Dec (pp)',
];

const PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS = [
  'Absolute Delta Azimuth',
  'Absolute Delta Pitch',
  'Absolute Azimuth + Pitch',
];

const PROJECT_ID_SUMMARY_DELTA_HEADERS = [
  'Delta Panel Count',
  'Delta Azimuth',
  PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS[0],
  'Delta Pitch',
  PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS[1],
  PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS[2],
].concat(PROJECT_ID_SUMMARY_COMPARISON_DELTA_HEADERS.slice(3));

const PROJECT_ID_SUMMARY_POSTHOG_HEADERS = [
  'Engine Version',
  'Created At',
  'Updated At',
  'Last Status Updated At',
  'Design Updated At',
];

const PROJECT_ID_SUMMARY_LATEST_AI_HEADERS = [
  'Latest AI Email Received At',
  'Proposed Production kWh',
  'Benchmark Production kWh',
  'Tolerance %',
];

const PROJECT_ID_SUMMARY_AI_CONTEXT_HEADERS = [
  'Gmail Message ID',
  'Required Evidence',
  'Technical Notes',
  'AI Summary',
];

const LEGACY_PROJECT_ID_SUMMARY_BASE_HEADERS = [
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

const PROJECT_ID_SUMMARY_PROJECT_DETAIL_HEADERS = [
  'Address',
  'State',
  'Region',
  'Solar Panel',
  'Inverter',
  'Installer',
  'Team Name',
];

const PROJECT_ID_SUMMARY_BASE_HEADERS =
  LEGACY_PROJECT_ID_SUMMARY_BASE_HEADERS.slice(0, 2).concat(
    PROJECT_ID_SUMMARY_PROJECT_DETAIL_HEADERS,
    LEGACY_PROJECT_ID_SUMMARY_BASE_HEADERS.slice(2),
  );

const PROJECT_ID_SUMMARY_HEADERS = PROJECT_ID_SUMMARY_BASE_HEADERS.concat(
  PROJECT_ID_SUMMARY_AI_CONTEXT_HEADERS,
  PROJECT_ID_SUMMARY_LATEST_AI_HEADERS,
  ['Production Category Group'],
  PROJECT_ID_SUMMARY_DELTA_HEADERS,
  PROJECT_ID_SUMMARY_POSTHOG_HEADERS,
);

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

const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3 = [
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

const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V4 =
  LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3.concat(
    PROJECT_ID_SUMMARY_COMPARISON_DELTA_HEADERS,
  );
const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V5 =
  LEGACY_PROJECT_ID_SUMMARY_HEADERS_V4.concat(
    PROJECT_ID_SUMMARY_POSTHOG_HEADERS,
  );
const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V6 =
  LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3.concat(
    PROJECT_ID_SUMMARY_DELTA_HEADERS,
    PROJECT_ID_SUMMARY_POSTHOG_HEADERS,
  );
const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V7 =
  LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3.concat(
    PROJECT_ID_SUMMARY_LATEST_AI_HEADERS,
    PROJECT_ID_SUMMARY_DELTA_HEADERS,
    PROJECT_ID_SUMMARY_POSTHOG_HEADERS,
  );
const LEGACY_PROJECT_ID_SUMMARY_HEADERS_V8 =
  LEGACY_PROJECT_ID_SUMMARY_BASE_HEADERS.concat(
    PROJECT_ID_SUMMARY_AI_CONTEXT_HEADERS,
    PROJECT_ID_SUMMARY_LATEST_AI_HEADERS,
    ['Production Category Group'],
    PROJECT_ID_SUMMARY_DELTA_HEADERS,
    PROJECT_ID_SUMMARY_POSTHOG_HEADERS,
  );
const PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX =
  PROJECT_ID_SUMMARY_BASE_HEADERS.length;
const PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX =
  PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX +
  PROJECT_ID_SUMMARY_AI_CONTEXT_HEADERS.length;
const PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX =
  PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX +
  PROJECT_ID_SUMMARY_LATEST_AI_HEADERS.length;
const PROJECT_ID_SUMMARY_DELTA_START_INDEX =
  PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX + 1;
const PROJECT_ID_SUMMARY_POSTHOG_START_INDEX =
  PROJECT_ID_SUMMARY_DELTA_START_INDEX +
  PROJECT_ID_SUMMARY_DELTA_HEADERS.length;
const PROJECT_ID_SUMMARY_EMAIL_COUNT_INDEX =
  PROJECT_ID_SUMMARY_HEADERS.indexOf('Email Count');
const PROJECT_ID_SUMMARY_LAST_EMAIL_INDEX =
  PROJECT_ID_SUMMARY_HEADERS.indexOf('Last Email Received At');
const PROJECT_ID_SUMMARY_MAP_DATA_SOURCE_INDEX =
  PROJECT_ID_SUMMARY_HEADERS.indexOf('Map Data Source');
const PROJECT_ID_SUMMARY_RGB_BASEMAP_URL_INDEX =
  PROJECT_ID_SUMMARY_HEADERS.indexOf('RGB Basemap URL');

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
 * Backward-compatible alias for the complete PostHog metadata preview.
 */
function previewProjectIdSummaryMapData() {
  return previewProjectIdSummaryPostHogData();
}

/**
 * Reads a small sample of Project IDs from both PostHog project and map
 * sources without writing the destination sheet.
 */
function previewProjectIdSummaryPostHogData() {
  const resources = getOrCreateResources_();
  const projects = loadProjectIdSummaryBaseProjects_(resources.spreadsheet)
    .slice(0, PROJECT_ID_SUMMARY_CONFIG.MAP_PREVIEW_LIMIT);
  const projectIds = projects.map((project) => project.projectId);
  const lookup = fetchProjectIdSummaryMapData_(
    projectIds,
  );
  const metadataLookup = fetchProjectIdSummaryProjectMetadata_(projectIds);
  const preview = projects.map((project) => {
    const mapData = lookup.byProjectId.get(project.key) || {};
    const metadata = metadataLookup.byProjectId.get(project.key) || {};
    return {
      projectId: project.projectId,
      mapLookupSource: mapData.lookupSource || '',
      mapDataSource: mapData.mapDataSource || '',
      rgbBasemapUrl: mapData.rgbBasemapUrl || '',
      projectLookupSource: metadata.lookupSource || '',
      address: metadata.address || '',
      state: metadata.state || '',
      region: getProjectIdSummaryRegion_(
        metadata.state,
        buildDefaultProjectIdSummaryStateRegionLookup_(),
      ),
      solarPanel: metadata.solarPanel || '',
      inverter: metadata.inverter || '',
      installer: metadata.installer || '',
      teamName: metadata.teamName || '',
      engineVersion: metadata.engineVersion || '',
      createdAt: metadata.createdAt || '',
      updatedAt: metadata.updatedAt || '',
      lastStatusUpdatedAt: metadata.lastStatusUpdatedAt || '',
      designUpdatedAt: metadata.designUpdatedAt || '',
    };
  });
  const result = {
    projectsPreviewed: projects.length,
    mapFoundInGoodLeap: lookup.foundInGoodLeap,
    mapFoundInArtemisSales: lookup.foundInArtemisSales,
    mapNotFound: lookup.notFound,
    mapErrors: lookup.errors.length,
    projectMetadataFoundInGoodLeap: metadataLookup.foundInGoodLeap,
    projectMetadataFoundInArtemisSales: metadataLookup.foundInArtemisSales,
    projectMetadataNotFound: metadataLookup.notFound,
    projectMetadataErrors: metadataLookup.errors.length,
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
    address: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Address')] || '',
    state: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('State')] || '',
    region: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Region')] || '',
    solarPanel: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Solar Panel')] || '',
    inverter: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Inverter')] || '',
    installer: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Installer')] || '',
    teamName: row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Team Name')] || '',
    emailCount: row[PROJECT_ID_SUMMARY_EMAIL_COUNT_INDEX],
    attachmentCount:
      row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Attachment Count')],
    analyzedPdfCount:
      row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Analyzed PDF Count')],
    firstEmailReceivedAt:
      row[PROJECT_ID_SUMMARY_HEADERS.indexOf('First Email Received At')] || '',
    lastEmailReceivedAt: row[PROJECT_ID_SUMMARY_LAST_EMAIL_INDEX] || '',
    mapDataSource: row[PROJECT_ID_SUMMARY_MAP_DATA_SOURCE_INDEX] || '',
    rgbBasemapUrl: row[PROJECT_ID_SUMMARY_RGB_BASEMAP_URL_INDEX] || '',
    gmailMessageId:
      row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX] || '',
    requiredEvidence:
      row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 1] || '',
    technicalNotes:
      row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 2] || '',
    aiSummary:
      row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 3] || '',
    latestAiEmailReceivedAt:
      row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX] || '',
    proposedProductionKwh:
      row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 1],
    benchmarkProductionKwh:
      row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 2],
    tolerancePercent:
      row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 3],
    productionCategoryGroup:
      row[PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX] || '',
    shadeReportDeltas: PROJECT_ID_SUMMARY_DELTA_HEADERS.reduce(
      (result, header, offset) => {
        result[header] = row[PROJECT_ID_SUMMARY_DELTA_START_INDEX + offset];
        return result;
      },
      {},
    ),
    engineVersion: row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX] || '',
    createdAt: row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 1] || '',
    updatedAt: row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 2] || '',
    lastStatusUpdatedAt:
      row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 3] || '',
    designUpdatedAt: row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 4] || '',
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
  const stateRegionsSheet =
    getOrCreateProjectIdSummaryStateRegionsSheet_(spreadsheet);
  const stateRegionLookup =
    loadProjectIdSummaryStateRegionLookup_(stateRegionsSheet);
  const sheet = getOrCreateProjectIdSummarySheet_(spreadsheet);
  const existingMapData = loadExistingProjectIdSummaryMapData_(sheet);
  const existingProjectMetadata =
    loadExistingProjectIdSummaryProjectMetadata_(sheet);
  const summary = buildProjectIdSummary_(spreadsheet, {
    refreshMapData: Boolean(options && options.refreshMapData),
    existingMapData,
    existingProjectMetadata,
    stateRegionLookup,
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
  if (typeof refreshShadeReportsComparisonProdSafely_ === 'function') {
    result.shadeReportsComparisonProd =
      refreshShadeReportsComparisonProdSafely_(spreadsheet);
  }
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
  const comparisonDeltas = loadProjectIdSummaryComparisonDeltas_(spreadsheet);
  const existingMapData = options && options.existingMapData
    ? options.existingMapData
    : new Map();
  const existingProjectMetadata = options && options.existingProjectMetadata
    ? options.existingProjectMetadata
    : new Map();
  const stateRegionLookup = options && options.stateRegionLookup
    ? options.stateRegionLookup
    : buildDefaultProjectIdSummaryStateRegionLookup_();
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
  const projectMetadataLookup = options && options.refreshMapData
    ? fetchProjectIdSummaryProjectMetadata_(
      projects.map((project) => project.projectId),
    )
    : emptyProjectIdSummaryProjectMetadataLookup_();
  const rows = [];
  let projectsWithoutEmails = 0;
  let projectsWithoutPdfs = 0;
  let projectsWithoutAttachments = 0;
  let projectsWithoutComparisonDeltas = 0;

  projects.forEach((project) => {
    const email = emailMetrics.get(project.key) || {
      count: 0,
      categorizedCount: 0,
      hasProduction: false,
      firstReceivedAt: '',
      lastReceivedAt: '',
      latestAnalysisReceivedAt: '',
      latestGmailMessageId: '',
      latestRequiredEvidence: '',
      latestTechnicalNotes: '',
      latestAiSummary: '',
      latestProposedProductionKwh: '',
      latestBenchmarkProductionKwh: '',
      latestTolerancePercent: '',
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
    const deltaValues = comparisonDeltas.get(project.key) ||
      Array(PROJECT_ID_SUMMARY_DELTA_HEADERS.length).fill('');
    if (!comparisonDeltas.has(project.key)) {
      projectsWithoutComparisonDeltas += 1;
    }
    const refreshedProjectMetadata =
      projectMetadataLookup.byProjectId.get(project.key);
    const projectMetadata = refreshedProjectMetadata ||
      existingProjectMetadata.get(project.key) || {};

    rows.push([
      project.projectId,
      project.projectUrl,
      projectMetadata.address || '',
      projectMetadata.state || '',
      getProjectIdSummaryRegion_(projectMetadata.state, stateRegionLookup),
      projectMetadata.solarPanel || '',
      projectMetadata.inverter || '',
      projectMetadata.installer || '',
      projectMetadata.teamName || '',
      email.count,
      attachmentCount,
      pdfCount,
      email.firstReceivedAt,
      email.lastReceivedAt,
      mapData.mapDataSource || '',
      mapData.rgbBasemapUrl || '',
      email.latestGmailMessageId,
      email.latestRequiredEvidence,
      email.latestTechnicalNotes,
      email.latestAiSummary,
      email.latestAnalysisReceivedAt,
      email.latestProposedProductionKwh,
      email.latestBenchmarkProductionKwh,
      email.latestTolerancePercent,
      getProjectIdSummaryCategoryGroup_(email),
    ].concat(
      deltaValues,
      [
        projectMetadata.engineVersion || '',
        projectMetadata.createdAt || '',
        projectMetadata.updatedAt || '',
        projectMetadata.lastStatusUpdatedAt || '',
        projectMetadata.designUpdatedAt || '',
      ],
    ));
  });

  rows.sort((left, right) => {
    const emailDifference =
      Number(right[PROJECT_ID_SUMMARY_EMAIL_COUNT_INDEX]) -
      Number(left[PROJECT_ID_SUMMARY_EMAIL_COUNT_INDEX]);
    if (emailDifference !== 0) return emailDifference;
    const rightTime = projectIdSummaryDateTime_(
      right[PROJECT_ID_SUMMARY_LAST_EMAIL_INDEX],
    );
    const leftTime = projectIdSummaryDateTime_(
      left[PROJECT_ID_SUMMARY_LAST_EMAIL_INDEX],
    );
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left[0]).localeCompare(String(right[0]));
  });

  return {
    rows,
    projectsWithoutEmails,
    projectsWithoutPdfs,
    projectsWithoutAttachments,
    projectsWithoutComparisonDeltas,
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
    projectMetadataLookup,
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
    projectsWithComparisonDeltas:
      summary.rows.length - summary.projectsWithoutComparisonDeltas,
    projectsWithoutComparisonDeltas: summary.projectsWithoutComparisonDeltas,
    projectsWithAddress: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Address')],
    ).length,
    projectsWithState: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('State')],
    ).length,
    projectsWithRegion: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Region')],
    ).length,
    projectsWithSolarPanel: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Solar Panel')],
    ).length,
    projectsWithInverter: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Inverter')],
    ).length,
    projectsWithInstaller: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Installer')],
    ).length,
    projectsWithTeamName: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_HEADERS.indexOf('Team Name')],
    ).length,
    projectsWithMapDataSource: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_MAP_DATA_SOURCE_INDEX],
    ).length,
    projectsWithRgbBasemapUrl: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_RGB_BASEMAP_URL_INDEX],
    ).length,
    projectsWithProduction: summary.rows.filter(
      (row) =>
        row[PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX] ===
        PROJECT_ID_SUMMARY_CONFIG.PRODUCTION_GROUP_LABEL,
    ).length,
    projectsWithoutProduction: summary.rows.filter(
      (row) =>
        row[PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX] ===
        PROJECT_ID_SUMMARY_CONFIG.OTHER_CATEGORIES_GROUP_LABEL,
    ).length,
    projectsWithoutCategoryGroup: summary.rows.filter(
      (row) => !row[PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX],
    ).length,
    projectsWithLatestGmailMessageId: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX],
    ).length,
    projectsWithLatestRequiredEvidence: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 1],
    ).length,
    projectsWithLatestTechnicalNotes: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 2],
    ).length,
    projectsWithLatestAiSummary: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 3],
    ).length,
    projectsWithLatestAiAnalysis: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX],
    ).length,
    projectsWithoutLatestAiAnalysis: summary.rows.filter(
      (row) => !row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX],
    ).length,
    projectsWithProposedProduction: summary.rows.filter(
      (row) => Number.isFinite(
        row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 1],
      ),
    ).length,
    projectsWithBenchmarkProduction: summary.rows.filter(
      (row) => Number.isFinite(
        row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 2],
      ),
    ).length,
    projectsWithTolerancePercent: summary.rows.filter(
      (row) => Number.isFinite(
        row[PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 3],
      ),
    ).length,
    mapFoundInGoodLeap: summary.mapLookup.foundInGoodLeap,
    mapFoundInArtemisSales: summary.mapLookup.foundInArtemisSales,
    mapNotFound: summary.mapLookup.notFound,
    mapQueryErrors: summary.mapLookup.errors.length,
    projectMetadataFoundInGoodLeap:
      summary.projectMetadataLookup.foundInGoodLeap,
    projectMetadataFoundInArtemisSales:
      summary.projectMetadataLookup.foundInArtemisSales,
    projectMetadataNotFound: summary.projectMetadataLookup.notFound,
    projectMetadataQueryErrors: summary.projectMetadataLookup.errors.length,
    projectsWithEngineVersion: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX],
    ).length,
    projectsWithCreatedAt: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 1],
    ).length,
    projectsWithUpdatedAt: summary.rows.filter(
      (row) => row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 2],
    ).length,
    projectsWithLastStatusUpdatedAt:
      summary.rows.filter(
        (row) => row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 3],
      ).length,
    projectsWithDesignUpdatedAt:
      summary.rows.filter(
        (row) => row[PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 4],
      ).length,
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

function emptyProjectIdSummaryProjectMetadataLookup_() {
  return {
    byProjectId: new Map(),
    foundInGoodLeap: 0,
    foundInArtemisSales: 0,
    notFound: 0,
    errors: [],
  };
}

/**
 * Fetches the current project metadata in batches. GoodLeap is authoritative;
 * Artemis Sales is queried only for Project IDs not found in GoodLeap.
 */
function fetchProjectIdSummaryProjectMetadata_(projectIds) {
  const uniqueProjectIds = Array.from(new Set(
    projectIds
      .map((projectId) => String(projectId || '').trim().toLowerCase())
      .filter((projectId) => isProjectIdSummaryUuid_(projectId)),
  ));
  if (
    uniqueProjectIds.length >
    PROJECT_ID_SUMMARY_CONFIG.MAX_PROJECT_IDS_PER_SYNC
  ) {
    throw new Error(
      `Project ID Summary found ${uniqueProjectIds.length} Project IDs, ` +
      `exceeding the safety limit of ` +
      `${PROJECT_ID_SUMMARY_CONFIG.MAX_PROJECT_IDS_PER_SYNC}.`,
    );
  }
  if (uniqueProjectIds.length === 0) {
    return emptyProjectIdSummaryProjectMetadataLookup_();
  }
  if (typeof getPostHogSolarSettings_ !== 'function') {
    throw new Error(
      'Project ID Summary requires the repository version of ' +
      'PostHogSolarTables.gs to query project metadata.',
    );
  }

  const settings = getPostHogSolarSettings_();
  const sources = [
    {
      label: 'GoodLeap',
      queryLabel: 'goodleap',
      table: settings.goodLeapProjectsTable,
      propertiesTable: projectIdSummaryRelatedTable_(
        settings.goodLeapProjectsTable,
        'properties',
      ),
      teamsTable: projectIdSummaryRelatedTable_(
        settings.goodLeapProjectsTable,
        'teams',
      ),
      installersTable: projectIdSummaryRelatedTable_(
        settings.goodLeapProjectsTable,
        'installers',
      ),
    },
    {
      label: 'Artemis Sales',
      queryLabel: 'artemis_sales',
      table: settings.artemisSalesProjectsTable,
      propertiesTable: projectIdSummaryRelatedTable_(
        settings.artemisSalesProjectsTable,
        'properties',
      ),
      teamsTable: projectIdSummaryRelatedTable_(
        settings.artemisSalesProjectsTable,
        'teams',
      ),
      installersTable: projectIdSummaryRelatedTable_(
        settings.artemisSalesProjectsTable,
        'installers',
      ),
    },
  ];
  const result = emptyProjectIdSummaryProjectMetadataLookup_();
  const failedProjectIds = new Set();
  let unresolved = uniqueProjectIds.slice();

  sources.forEach((source) => {
    if (unresolved.length === 0) return;
    const sourceIds = unresolved.slice();
    chunkPostHogArray_(
      sourceIds,
      PROJECT_ID_SUMMARY_CONFIG.MAP_QUERY_BATCH_SIZE,
    ).forEach((batch) => {
      try {
        const found = fetchProjectIdSummaryProjectMetadataFromTable_(
          batch,
          source,
          settings,
        );
        found.forEach((metadata, projectId) => {
          if (result.byProjectId.has(projectId)) return;
          result.byProjectId.set(projectId, metadata);
          if (source.label === 'GoodLeap') {
            result.foundInGoodLeap += 1;
          } else {
            result.foundInArtemisSales += 1;
          }
        });
      } catch (error) {
        const safeError = truncatePostHogText_(String(error), 1000);
        batch.forEach((projectId) => failedProjectIds.add(projectId));
        result.errors.push({
          lookupSource: source.label,
          projectIds: batch.slice(),
          error: safeError,
        });
        console.error(`[PROJECT METADATA ERROR] ${safeError}`);
      }
    });
    unresolved = unresolved.filter(
      (projectId) => !result.byProjectId.has(projectId),
    );
  });
  result.notFound = unresolved.filter(
    (projectId) => !failedProjectIds.has(projectId),
  ).length;
  return result;
}

function fetchProjectIdSummaryProjectMetadataFromTable_(
  projectIds,
  source,
  settings,
) {
  if (projectIds.length === 0) return new Map();
  const literals = projectIds
    .map((projectId) => postHogStringLiteral_(projectId))
    .join(', ');
  const projectIdExpression = `toString(p.${settings.projectIdField})`;
  const projectAddress = `coalesce(nullIf(p.project_address, ''), ` +
    `property.street, '')`;
  const projectCity = `coalesce(nullIf(p.project_city, ''), property.city, '')`;
  const projectState =
    `coalesce(nullIf(p.project_state, ''), property.state, '')`;
  const projectZipcode =
    `coalesce(nullIf(p.project_zipcode, ''), property.zipcode, '')`;
  const query = [
    'SELECT',
    `  ${projectIdExpression} AS project_id,`,
    `  concat(${projectAddress},`,
    `    if(${projectCity} = '', '', concat(', ', ${projectCity})),`,
    `    if(${projectState} = '', '', concat(', ', ${projectState})),`,
    `    if(${projectZipcode} = '', '', concat(' ', ${projectZipcode}))) ` +
      'AS address,',
    `  ${projectState} AS state,`,
    '  p.solar_panel_type AS solar_panel,',
    '  p.inverter_type AS inverter,',
    '  installer.name AS installer,',
    '  team.name AS team_name,',
    `  p.${PROJECT_ID_SUMMARY_CONFIG.PROJECT_ENGINE_VERSION_FIELD} ` +
      'AS engine_version,',
    `  p.${PROJECT_ID_SUMMARY_CONFIG.PROJECT_CREATED_AT_FIELD} ` +
      'AS created_at,',
    `  p.${PROJECT_ID_SUMMARY_CONFIG.PROJECT_UPDATED_AT_FIELD} ` +
      'AS updated_at,',
    `  p.${PROJECT_ID_SUMMARY_CONFIG.PROJECT_LAST_STATUS_UPDATED_AT_FIELD} ` +
      'AS last_status_updated_at,',
    `  p.${PROJECT_ID_SUMMARY_CONFIG.PROJECT_DESIGN_UPDATED_AT_FIELD} ` +
      'AS design_updated_at',
    `FROM ${source.table} AS p`,
    `LEFT ANY JOIN ${source.propertiesTable} AS property`,
    '  ON toString(property.id) = toString(p.property_id)',
    `LEFT ANY JOIN ${source.teamsTable} AS team`,
    '  ON toString(team.id) = toString(p.team_id)',
    `LEFT ANY JOIN ${source.installersTable} AS installer`,
    '  ON toString(installer.id) = toString(team.installer_id)',
    `WHERE ${projectIdExpression} IN (${literals})`,
    `ORDER BY p.${settings.sourceUpdatedAtField} DESC, ${projectIdExpression}`,
    `LIMIT ${Math.max(projectIds.length * 2, projectIds.length)}`,
  ].join('\n');
  const response = executePostHogHogQL_(
    query,
    `goodleap_apps_script_${source.queryLabel}_project_metadata`,
  );
  return parseProjectIdSummaryProjectMetadata_(response, source.label);
}

function parseProjectIdSummaryProjectMetadata_(response, lookupSource) {
  const columns = response.columns.map((column) => String(column).toLowerCase());
  const requiredColumns = [
    'project_id',
    'address',
    'state',
    'solar_panel',
    'inverter',
    'installer',
    'team_name',
    'engine_version',
    'created_at',
    'updated_at',
    'last_status_updated_at',
    'design_updated_at',
  ];
  const indexes = {};
  requiredColumns.forEach((column) => {
    indexes[column] = columns.indexOf(column);
  });
  const missing = requiredColumns.filter((column) => indexes[column] < 0);
  if (missing.length > 0) {
    throw new Error(
      `Unexpected PostHog project metadata columns; missing: ` +
      `${missing.join(', ')}. Returned: ${response.columns.join(', ')}.`,
    );
  }

  const byProjectId = new Map();
  response.results.forEach((row) => {
    const projectId = String(row[indexes.project_id] || '')
      .trim()
      .toLowerCase();
    if (!isProjectIdSummaryUuid_(projectId) || byProjectId.has(projectId)) {
      return;
    }
    const rawEngineVersion = row[indexes.engine_version];
    byProjectId.set(projectId, {
      lookupSource,
      address: String(row[indexes.address] || '').trim(),
      state: normalizeProjectIdSummaryState_(row[indexes.state]),
      solarPanel: String(row[indexes.solar_panel] || '').trim(),
      inverter: String(row[indexes.inverter] || '').trim(),
      installer: String(row[indexes.installer] || '').trim(),
      teamName: String(row[indexes.team_name] || '').trim(),
      engineVersion:
        rawEngineVersion === null || rawEngineVersion === undefined
          ? ''
          : String(rawEngineVersion).trim(),
      createdAt: normalizeProjectIdSummaryDate_(row[indexes.created_at]),
      updatedAt: normalizeProjectIdSummaryDate_(row[indexes.updated_at]),
      lastStatusUpdatedAt: normalizeProjectIdSummaryDate_(
        row[indexes.last_status_updated_at],
      ),
      designUpdatedAt: normalizeProjectIdSummaryDate_(
        row[indexes.design_updated_at],
      ),
    });
  });
  return byProjectId;
}

function projectIdSummaryRelatedTable_(projectsTable, relatedEntity) {
  const table = String(projectsTable || '').trim();
  if (!/_projects$/i.test(table)) {
    throw new Error(
      `Cannot derive ${relatedEntity} table from project table ${table}.`,
    );
  }
  return table.replace(/projects$/i, relatedEntity);
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

function loadExistingProjectIdSummaryProjectMetadata_(sheet) {
  const byProjectId = new Map();
  if (!sheet || sheet.getLastRow() < 2) return byProjectId;
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), PROJECT_ID_SUMMARY_HEADERS.length)
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = headers.indexOf('Project ID');
  const projectDetailIndexes = PROJECT_ID_SUMMARY_PROJECT_DETAIL_HEADERS.map(
    (header) => headers.indexOf(header),
  );
  const metadataIndexes = PROJECT_ID_SUMMARY_POSTHOG_HEADERS.map(
    (header) => headers.indexOf(header),
  );
  if (
    projectIdIndex < 0 ||
    projectDetailIndexes.some((index) => index < 0) ||
    metadataIndexes.some((index) => index < 0)
  ) {
    return byProjectId;
  }

  values.slice(1).forEach((row) => {
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (!isProjectIdSummaryUuid_(projectId)) return;
    byProjectId.set(projectId, {
      address: String(row[projectDetailIndexes[0]] || '').trim(),
      state: normalizeProjectIdSummaryState_(row[projectDetailIndexes[1]]),
      solarPanel: String(row[projectDetailIndexes[3]] || '').trim(),
      inverter: String(row[projectDetailIndexes[4]] || '').trim(),
      installer: String(row[projectDetailIndexes[5]] || '').trim(),
      teamName: String(row[projectDetailIndexes[6]] || '').trim(),
      engineVersion: String(row[metadataIndexes[0]] || '').trim(),
      createdAt: normalizeProjectIdSummaryDate_(row[metadataIndexes[1]]),
      updatedAt: normalizeProjectIdSummaryDate_(row[metadataIndexes[2]]),
      lastStatusUpdatedAt: normalizeProjectIdSummaryDate_(
        row[metadataIndexes[3]],
      ),
      designUpdatedAt: normalizeProjectIdSummaryDate_(
        row[metadataIndexes[4]],
      ),
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
  const gmailMessageIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Gmail Message ID',
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
  const proposedProductionIndex = requireProjectIdSummaryHeader_(
    headers,
    'Proposed Production kWh',
    sheet.getName(),
  );
  const benchmarkProductionIndex = requireProjectIdSummaryHeader_(
    headers,
    'Benchmark Production kWh',
    sheet.getName(),
  );
  const tolerancePercentIndex = requireProjectIdSummaryHeader_(
    headers,
    'Tolerance %',
    sheet.getName(),
  );
  const requiredEvidenceIndex = requireProjectIdSummaryHeader_(
    headers,
    'Required Evidence',
    sheet.getName(),
  );
  const technicalNotesIndex = requireProjectIdSummaryHeader_(
    headers,
    'Technical Notes',
    sheet.getName(),
  );
  const aiSummaryIndex = requireProjectIdSummaryHeader_(
    headers,
    'AI Summary',
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
        latestAnalysisReceivedAt: '',
        latestGmailMessageId: '',
        latestRequiredEvidence: '',
        latestTechnicalNotes: '',
        latestAiSummary: '',
        latestProposedProductionKwh: '',
        latestBenchmarkProductionKwh: '',
        latestTolerancePercent: '',
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
        if (
          !metric.latestAnalysisReceivedAt ||
          receivedAt.getTime() >= metric.latestAnalysisReceivedAt.getTime()
        ) {
          metric.latestAnalysisReceivedAt = receivedAt;
          metric.latestGmailMessageId = String(
            row[gmailMessageIdIndex] || '',
          ).trim();
          metric.latestRequiredEvidence = String(
            row[requiredEvidenceIndex] || '',
          );
          metric.latestTechnicalNotes = String(
            row[technicalNotesIndex] || '',
          );
          metric.latestAiSummary = String(row[aiSummaryIndex] || '');
          metric.latestProposedProductionKwh =
            normalizeProjectIdSummaryNumber_(row[proposedProductionIndex]);
          metric.latestBenchmarkProductionKwh =
            normalizeProjectIdSummaryNumber_(row[benchmarkProductionIndex]);
          metric.latestTolerancePercent =
            normalizeProjectIdSummaryNumber_(row[tolerancePercentIndex]);
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

/**
 * Loads the final Delta values from each project's recalculated comparison row.
 * Values remain blank when the comparison row or individual metric is missing.
 */
function loadProjectIdSummaryComparisonDeltas_(spreadsheet) {
  const byProjectId = new Map();
  const sheet = spreadsheet.getSheetByName(
    PROJECT_ID_SUMMARY_CONFIG.COMPARISON_SHEET_NAME,
  );
  if (!sheet || sheet.getLastRow() < 2) return byProjectId;

  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn())
    .getValues();
  const headers = values[0].map((value) => String(value).trim());
  const projectIdIndex = requireProjectIdSummaryHeader_(
    headers,
    'Project ID',
    sheet.getName(),
  );
  const matchTypeIndex = requireProjectIdSummaryHeader_(
    headers,
    'Match Type',
    sheet.getName(),
  );
  const deltaIndexes = PROJECT_ID_SUMMARY_COMPARISON_DELTA_HEADERS.map(
    (header) =>
      requireProjectIdSummaryHeader_(headers, header, sheet.getName()),
  );

  values.slice(1).forEach((row) => {
    const matchType = String(row[matchTypeIndex] || '').trim();
    if (matchType !== PROJECT_ID_SUMMARY_CONFIG.COMPARISON_MATCH_TYPE) return;
    const projectId = String(row[projectIdIndex] || '').trim().toLowerCase();
    if (!isProjectIdSummaryUuid_(projectId)) return;
    const comparisonValues = deltaIndexes.map((index) =>
      Number.isFinite(row[index]) ? row[index] : '',
    );
    byProjectId.set(
      projectId,
      buildProjectIdSummaryDeltaValues_(comparisonValues),
    );
  });
  return byProjectId;
}

function buildProjectIdSummaryDeltaValues_(comparisonValues) {
  const deltaAzimuth = comparisonValues[1];
  const deltaPitch = comparisonValues[2];
  const hasDeltaAzimuth = Number.isFinite(deltaAzimuth);
  const hasDeltaPitch = Number.isFinite(deltaPitch);
  const absoluteDeltaAzimuth = hasDeltaAzimuth
    ? Math.abs(deltaAzimuth)
    : '';
  const absoluteDeltaPitch = hasDeltaPitch ? Math.abs(deltaPitch) : '';
  const absoluteAzimuthAndPitch = hasDeltaAzimuth && hasDeltaPitch
    ? absoluteDeltaAzimuth + absoluteDeltaPitch
    : '';

  return [
    comparisonValues[0],
    deltaAzimuth,
    absoluteDeltaAzimuth,
    deltaPitch,
    absoluteDeltaPitch,
    absoluteAzimuthAndPitch,
  ].concat(comparisonValues.slice(3));
}

function getOrCreateProjectIdSummaryStateRegionsSheet_(spreadsheet) {
  const sheetName = PROJECT_ID_SUMMARY_CONFIG.STATE_REGIONS_SHEET_NAME;
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);

  if (sheet.getMaxColumns() < 2) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 2 - sheet.getMaxColumns());
  }
  const requiredRows = PROJECT_ID_SUMMARY_STATE_REGIONS.length + 1;
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }

  const currentHeaders = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 2))
        .getDisplayValues()[0]
        .map((value) => String(value).trim())
    : [];
  const expectedHeaders = ['State', 'Region'];
  const hasUnexpectedContent = currentHeaders.some(Boolean) &&
    !projectIdSummaryHeadersMatch_(currentHeaders, expectedHeaders);
  if (hasUnexpectedContent) {
    throw new Error(
      `${sheetName} already exists with an unexpected schema. ` +
      'Rename or review that sheet before setup so no data is overwritten.',
    );
  }

  const expectedRows = [expectedHeaders].concat(PROJECT_ID_SUMMARY_STATE_REGIONS);
  const currentRows = sheet.getLastRow() >= expectedRows.length
    ? sheet.getRange(1, 1, expectedRows.length, 2).getDisplayValues()
    : [];
  if (
    sheet.getLastRow() !== expectedRows.length ||
    !projectIdSummarySimpleRowsEqual_(currentRows, expectedRows)
  ) {
    if (sheet.getLastRow() > 0) {
      sheet.getRange(1, 1, sheet.getLastRow(), 2).clearContent();
    }
    sheet.getRange(1, 1, expectedRows.length, 2).setValues(expectedRows);
  }

  sheet
    .getRange(1, 1, 1, 2)
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.HEADER_BACKGROUND)
    .setFontColor(PROJECT_ID_SUMMARY_CONFIG.HEADER_FONT_COLOR)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet
    .getRange(2, 1, PROJECT_ID_SUMMARY_STATE_REGIONS.length, 2)
    .setBackground('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setTabColor(PROJECT_ID_SUMMARY_CONFIG.TAB_COLOR);
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 150);
  return sheet;
}

function loadProjectIdSummaryStateRegionLookup_(sheet) {
  const values = sheet
    .getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2)
    .getDisplayValues();
  const headers = values[0].map((value) => String(value).trim());
  const stateIndex = requireProjectIdSummaryHeader_(
    headers,
    'State',
    sheet.getName(),
  );
  const regionIndex = requireProjectIdSummaryHeader_(
    headers,
    'Region',
    sheet.getName(),
  );
  const lookup = new Map();
  values.slice(1).forEach((row) => {
    const state = normalizeProjectIdSummaryState_(row[stateIndex]);
    const region = String(row[regionIndex] || '').trim();
    if (state && region) lookup.set(state, region);
  });
  return lookup;
}

function buildDefaultProjectIdSummaryStateRegionLookup_() {
  const lookup = new Map();
  PROJECT_ID_SUMMARY_STATE_REGIONS.forEach(([state, region]) => {
    lookup.set(state, region);
  });
  return lookup;
}

function getProjectIdSummaryRegion_(state, lookup) {
  return lookup.get(normalizeProjectIdSummaryState_(state)) || '';
}

function normalizeProjectIdSummaryState_(value) {
  const state = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(state) ? state : '';
}

function projectIdSummarySimpleRowsEqual_(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  return rightRows.every((rightRow, rowIndex) =>
    rightRow.every(
      (value, columnIndex) =>
        String(leftRows[rowIndex][columnIndex] || '').trim() === String(value),
    ),
  );
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
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V4,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V5,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V6,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V7,
    ) &&
    !projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V8,
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
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V1,
    );
    console.log(
      'Project ID Summary schema upgraded: Map Data Source, RGB Basemap URL, ' +
      'Production Category Group, Shade Report Deltas, and PostHog project ' +
      'metadata were appended.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V2,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V2,
    );
    console.log(
      'Project ID Summary schema upgraded: Production Category Group and ' +
      'Shade Report Delta and PostHog project metadata columns were appended.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V3,
    );
    console.log(
      'Project ID Summary schema upgraded: Shade Report Delta and PostHog ' +
      'project metadata columns were appended.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V4,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V4,
    );
    console.log(
      'Project ID Summary schema upgraded: Engine Version and project date ' +
      'columns were appended.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V5,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V5,
    );
    console.log(
      'Project ID Summary schema upgraded: absolute Azimuth and Pitch Delta ' +
      'columns and latest AI production values were inserted. Existing ' +
      'project metadata was shifted safely.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V6,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V6,
    );
    console.log(
      'Project ID Summary schema upgraded: latest AI email and production ' +
      'columns were inserted and existing values were shifted safely.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V7,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V7,
    );
    console.log(
      'Project ID Summary schema upgraded: latest Gmail context was inserted, ' +
      'Production Category Group was moved after Tolerance %, and existing ' +
      'Delta and PostHog values were shifted safely.',
    );
  } else if (
    projectIdSummaryHeadersMatch_(
      currentHeaders,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V8,
    )
  ) {
    migrateProjectIdSummarySchema_(
      sheet,
      LEGACY_PROJECT_ID_SUMMARY_HEADERS_V8,
    );
    console.log(
      'Project ID Summary schema upgraded: Address, State, Region, Solar Panel, ' +
      'Inverter, Installer, and Team Name were inserted after Project URL. ' +
      'Existing values were shifted safely.',
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
  const aiContextStartColumn = PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 1;
  const latestAiStartColumn = PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 1;
  const categoryGroupColumn = PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX + 1;
  const deltaStartColumn = PROJECT_ID_SUMMARY_DELTA_START_INDEX + 1;
  sheet
    .getRange(
      1,
      deltaStartColumn,
      1,
      PROJECT_ID_SUMMARY_DELTA_HEADERS.length,
    )
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.DELTA_HEADER_BACKGROUND);
  styleProjectIdSummaryAbsoluteDeltaColumns_(sheet, 1, 1, true);
  const metadataStartColumn = PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 1;
  sheet
    .getRange(
      1,
      metadataStartColumn,
      1,
      PROJECT_ID_SUMMARY_POSTHOG_HEADERS.length,
    )
    .setBackground(
      PROJECT_ID_SUMMARY_CONFIG.PROJECT_METADATA_HEADER_BACKGROUND,
    );
  sheet.setFrozenRows(1);
  sheet.setTabColor(PROJECT_ID_SUMMARY_CONFIG.TAB_COLOR);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 520);
  sheet.setColumnWidth(projectIdSummaryColumn_('Address'), 300);
  sheet.setColumnWidth(projectIdSummaryColumn_('State'), 90);
  sheet.setColumnWidth(projectIdSummaryColumn_('Region'), 120);
  sheet.setColumnWidths(projectIdSummaryColumn_('Solar Panel'), 2, 220);
  sheet.setColumnWidths(projectIdSummaryColumn_('Installer'), 2, 180);
  sheet.setColumnWidths(projectIdSummaryColumn_('Email Count'), 3, 135);
  sheet.setColumnWidths(
    projectIdSummaryColumn_('First Email Received At'),
    2,
    180,
  );
  sheet.setColumnWidth(projectIdSummaryColumn_('Map Data Source'), 180);
  sheet.setColumnWidth(projectIdSummaryColumn_('RGB Basemap URL'), 520);
  sheet.setColumnWidth(aiContextStartColumn, 180);
  sheet.setColumnWidth(aiContextStartColumn + 1, 360);
  sheet.setColumnWidths(aiContextStartColumn + 2, 2, 520);
  sheet.setColumnWidth(latestAiStartColumn, 180);
  sheet.setColumnWidths(latestAiStartColumn + 1, 2, 175);
  sheet.setColumnWidth(latestAiStartColumn + 3, 135);
  sheet.setColumnWidth(categoryGroupColumn, 260);
  sheet.setColumnWidths(
    deltaStartColumn,
    PROJECT_ID_SUMMARY_DELTA_HEADERS.length,
    135,
  );
  PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS.forEach((header) => {
    const column = PROJECT_ID_SUMMARY_HEADERS.indexOf(header) + 1;
    sheet.setColumnWidth(
      column,
      header === 'Absolute Azimuth + Pitch' ? 190 : 165,
    );
  });
  sheet.setColumnWidth(metadataStartColumn, 135);
  sheet.setColumnWidths(metadataStartColumn + 1, 4, 180);
  const existingDataRows = Math.max(0, sheet.getLastRow() - 1);
  if (existingDataRows > 0) {
    formatProjectIdSummaryRows_(sheet, 2, existingDataRows);
  }
  return sheet;
}

function migrateProjectIdSummarySchema_(sheet, sourceHeaders) {
  const dataRowCount = Math.max(0, sheet.getLastRow() - 1);
  if (dataRowCount === 0) return;

  const sourceRows = sheet
    .getRange(2, 1, dataRowCount, sourceHeaders.length)
    .getValues();
  const sourceIndexByHeader = new Map();
  sourceHeaders.forEach((header, index) => {
    sourceIndexByHeader.set(header, index);
  });
  const migratedRows = sourceRows.map((sourceRow) => {
    const migratedRow = PROJECT_ID_SUMMARY_HEADERS.map((header) => {
      const sourceIndex = sourceIndexByHeader.get(header);
      return sourceIndex === undefined ? '' : sourceRow[sourceIndex];
    });
    const deltaAzimuth = migratedRow[
      PROJECT_ID_SUMMARY_HEADERS.indexOf('Delta Azimuth')
    ];
    const deltaPitch = migratedRow[
      PROJECT_ID_SUMMARY_HEADERS.indexOf('Delta Pitch')
    ];
    const hasDeltaAzimuth = Number.isFinite(deltaAzimuth);
    const hasDeltaPitch = Number.isFinite(deltaPitch);
    const absoluteDeltaAzimuth = hasDeltaAzimuth
      ? Math.abs(deltaAzimuth)
      : '';
    const absoluteDeltaPitch = hasDeltaPitch ? Math.abs(deltaPitch) : '';
    migratedRow[
      PROJECT_ID_SUMMARY_HEADERS.indexOf('Absolute Delta Azimuth')
    ] = absoluteDeltaAzimuth;
    migratedRow[
      PROJECT_ID_SUMMARY_HEADERS.indexOf('Absolute Delta Pitch')
    ] = absoluteDeltaPitch;
    migratedRow[
      PROJECT_ID_SUMMARY_HEADERS.indexOf('Absolute Azimuth + Pitch')
    ] = hasDeltaAzimuth && hasDeltaPitch
      ? absoluteDeltaAzimuth + absoluteDeltaPitch
      : '';
    return migratedRow;
  });

  sheet
    .getRange(
      2,
      1,
      dataRowCount,
      Math.max(sourceHeaders.length, PROJECT_ID_SUMMARY_HEADERS.length),
    )
    .clearContent();
  sheet
    .getRange(2, 1, dataRowCount, PROJECT_ID_SUMMARY_HEADERS.length)
    .setValues(migratedRows);
  setProjectIdSummaryRichLinks_(sheet, migratedRows);
}

function styleProjectIdSummaryAbsoluteDeltaColumns_(
  sheet,
  startRow,
  rowCount,
  isHeader,
) {
  const background = isHeader
    ? PROJECT_ID_SUMMARY_CONFIG.ABSOLUTE_DELTA_HEADER_BACKGROUND
    : PROJECT_ID_SUMMARY_CONFIG.ABSOLUTE_DELTA_DATA_BACKGROUND;
  PROJECT_ID_SUMMARY_ABSOLUTE_DELTA_HEADERS.forEach((header) => {
    const column = PROJECT_ID_SUMMARY_HEADERS.indexOf(header) + 1;
    sheet.getRange(startRow, column, rowCount, 1).setBackground(background);
  });
}

function formatProjectIdSummaryRows_(sheet, startRow, rowCount) {
  if (rowCount < 1) return;

  sheet
    .getRange(
      startRow,
      projectIdSummaryColumn_('Address'),
      rowCount,
      PROJECT_ID_SUMMARY_PROJECT_DETAIL_HEADERS.length,
    )
    .setBackground('#ffffff')
    .setNumberFormat('@')
    .setWrap(false);
  sheet
    .getRange(
      startRow,
      projectIdSummaryColumn_('Email Count'),
      rowCount,
      3,
    )
    .setNumberFormat('#,##0');
  sheet
    .getRange(
      startRow,
      projectIdSummaryColumn_('First Email Received At'),
      rowCount,
      2,
    )
    .setNumberFormat(PROJECT_ID_SUMMARY_CONFIG.DATE_FORMAT);
  sheet.getRange(startRow, 1, rowCount, 2).setWrap(false);
  sheet
    .getRange(
      startRow,
      projectIdSummaryColumn_('Map Data Source'),
      rowCount,
      2,
    )
    .setWrap(false);
  const aiContextStartColumn = PROJECT_ID_SUMMARY_AI_CONTEXT_START_INDEX + 1;
  sheet
    .getRange(
      startRow,
      aiContextStartColumn,
      rowCount,
      PROJECT_ID_SUMMARY_AI_CONTEXT_HEADERS.length,
    )
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.LATEST_AI_DATA_BACKGROUND)
    .setWrap(false);

  const latestAiStartColumn = PROJECT_ID_SUMMARY_LATEST_AI_START_INDEX + 1;
  sheet
    .getRange(
      startRow,
      latestAiStartColumn,
      rowCount,
      PROJECT_ID_SUMMARY_LATEST_AI_HEADERS.length,
    )
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.LATEST_AI_DATA_BACKGROUND)
    .setWrap(false);
  sheet
    .getRange(startRow, latestAiStartColumn, rowCount, 1)
    .setNumberFormat(PROJECT_ID_SUMMARY_CONFIG.DATE_FORMAT);
  sheet
    .getRange(startRow, latestAiStartColumn + 1, rowCount, 2)
    .setNumberFormat('0.###');
  sheet
    .getRange(startRow, latestAiStartColumn + 3, rowCount, 1)
    .setNumberFormat('0.##');
  sheet
    .getRange(
      startRow,
      PROJECT_ID_SUMMARY_CATEGORY_GROUP_INDEX + 1,
      rowCount,
      1,
    )
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.LATEST_AI_DATA_BACKGROUND)
    .setWrap(false);

  const deltaStartColumn = PROJECT_ID_SUMMARY_DELTA_START_INDEX + 1;
  sheet
    .getRange(
      startRow,
      deltaStartColumn,
      rowCount,
      PROJECT_ID_SUMMARY_DELTA_HEADERS.length,
    )
    .setNumberFormat('0.####')
    .setBackground(PROJECT_ID_SUMMARY_CONFIG.DELTA_DATA_BACKGROUND)
    .setWrap(false);
  styleProjectIdSummaryAbsoluteDeltaColumns_(
    sheet,
    startRow,
    rowCount,
    false,
  );

  const metadataStartColumn = PROJECT_ID_SUMMARY_POSTHOG_START_INDEX + 1;
  sheet
    .getRange(
      startRow,
      metadataStartColumn,
      rowCount,
      PROJECT_ID_SUMMARY_POSTHOG_HEADERS.length,
    )
    .setBackground(
      PROJECT_ID_SUMMARY_CONFIG.PROJECT_METADATA_DATA_BACKGROUND,
    )
    .setWrap(false);
  sheet
    .getRange(startRow, metadataStartColumn, rowCount, 1)
    .setNumberFormat('@');
  sheet
    .getRange(startRow, metadataStartColumn + 1, rowCount, 4)
    .setNumberFormat(PROJECT_ID_SUMMARY_CONFIG.DATE_FORMAT);
}

function projectIdSummaryHeadersMatch_(currentHeaders, expectedHeaders) {
  if (currentHeaders.length < expectedHeaders.length) return false;
  if (!expectedHeaders.every(
    (header, index) => currentHeaders[index] === header,
  )) return false;
  return currentHeaders.slice(expectedHeaders.length).every((header) => !header);
}

function projectIdSummaryColumn_(header) {
  const index = PROJECT_ID_SUMMARY_HEADERS.indexOf(header);
  if (index < 0) throw new Error(`Unknown Project ID Summary header: ${header}.`);
  return index + 1;
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
  formatProjectIdSummaryRows_(sheet, 2, rows.length);

  setProjectIdSummaryRichLinks_(sheet, rows);
}

function setProjectIdSummaryRichLinks_(sheet, rows) {
  const richUrls = rows.map((row) => {
    const url = String(row[1] || '').trim();
    const builder = SpreadsheetApp.newRichTextValue().setText(url);
    if (url) builder.setLinkUrl(url);
    return [builder.build()];
  });
  sheet.getRange(2, 2, rows.length, 1).setRichTextValues(richUrls);

  const richBasemapUrls = rows.map((row) => {
    const url = safeProjectIdSummaryUrl_(
      row[PROJECT_ID_SUMMARY_RGB_BASEMAP_URL_INDEX],
    );
    const builder = SpreadsheetApp.newRichTextValue().setText(url);
    if (url) builder.setLinkUrl(url);
    return [builder.build()];
  });
  sheet
    .getRange(
      2,
      PROJECT_ID_SUMMARY_RGB_BASEMAP_URL_INDEX + 1,
      rows.length,
      1,
    )
    .setRichTextValues(richBasemapUrls);
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

function normalizeProjectIdSummaryNumber_(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : '';
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : '';
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

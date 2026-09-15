/**
 * GoodLeap TPO - Google Sheets -> PostHog project lookup
 *
 * This file belongs in the SAME Apps Script project as Code.gs and
 * ManualBackfill.gs. It reads unique Case IDs from the Emails sheet, treats
 * them as GoodLeap financier application IDs, looks up the corresponding
 * Artemis project in PostHog, and maintains one derived row per application
 * in the "PostHog Projects" sheet.
 *
 * Safe first-run sequence:
 *   1) setupPostHogProjectSync()
 *   2) testPostHogConnection()
 *   3) inspectPostHogGoodLeapProjectSchema()
 *   4) inspectPostHogGoodLeapDatabaseSchema()
 *   5) previewPostHogProjectMatches()
 *   6) syncPostHogProjects()
 *   7) previewProjectIdSummaryMapData()
 *   8) setupProjectIdSummary()
 *   9) setupTOFValuesComparison()
 *  10) installHybridGoodLeapPostHogTriggers()
 *
 * The preview and schema inspection functions do not write project results.
 * No PostHog API key is stored in this source file or in Google Sheets.
 */

const POSTHOG_SYNC_CONFIG = {
  SHEET_NAME: 'PostHog Projects',
  SOURCE_SHEET_NAME: 'Emails',
  SOURCE_APPLICATION_ID_HEADER: 'Case ID',
  SOURCE_GOOGLE_GROUP_URL_HEADER: 'Google Group URL',
  ATTACHMENTS_SHEET_NAME: 'Attachments',
  ATTACHMENT_APPLICATION_ID_HEADER: 'Case ID',
  ATTACHMENT_FILENAME_HEADER: 'Original Filename',
  ATTACHMENT_URL_HEADER: 'Drive URL',

  // PostHog schema discovery confirms that the financier table contains the
  // Application ID and its related Artemis project ID directly.
  DEFAULT_LOOKUP_TABLE: 'goodleap_postgres_financiers',
  DEFAULT_FALLBACK_LOOKUP_TABLE: 'artemis_sales_postgres_financiers',
  DEFAULT_FALLBACK_PROJECTS_TABLE: 'artemis_sales_postgres_projects',
  DEFAULT_FALLBACK_ORGANIZATIONS_TABLE:
    'artemis_sales_postgres_organizations',
  DEFAULT_MAP_SOURCE_TABLE: 'goodleap_postgres_projectmapsources',
  DEFAULT_FALLBACK_MAP_SOURCE_TABLE:
    'artemis_sales_postgres_projectmapsources',
  DEFAULT_APPLICATION_ID_FIELD: 'application_id',
  DEFAULT_PROJECT_ID_FIELD: 'project_id',
  DEFAULT_SOURCE_UPDATED_AT_FIELD: 'updated_at',
  DEFAULT_PROJECT_ORGANIZATION_ID_FIELD: 'organization_id',
  DEFAULT_ORGANIZATION_NAME_FIELD: 'name',
  DEFAULT_MAP_SOURCE_PROJECT_ID_FIELD: 'project_id',
  DEFAULT_MAP_DATA_SOURCE_FIELD: 'map_data_source',
  DEFAULT_RGB_BASEMAP_URL_FIELD: 'rgb_basemap_url',
  DEFAULT_MAP_SOURCE_UPDATED_AT_FIELD: 'updated_at',

  // Existing GoodLeap records in this repository use this URL shape.
  DEFAULT_PROJECT_URL_PREFIX: 'https://goodleap.artemis.solar/projects/',
  DEFAULT_FALLBACK_PROJECT_URL_PREFIX: 'https://sales.artemis.solar/projects/',
  DEFAULT_PROJECT_URL_SUFFIX: '/proposal',

  PREVIEW_APPLICATION_ID_LIMIT: 10,
  QUERY_BATCH_SIZE: 100,
  MAX_APPLICATION_IDS_PER_SYNC: 5000,
  MAX_MATCHES_PER_BATCH: 1000,
  TRIGGER_EVERY_HOURS: 1,
};

const POSTHOG_PROPERTY_KEYS = {
  HOST: 'POSTHOG_HOST',
  PROJECT_ID: 'POSTHOG_PROJECT_ID',
  PERSONAL_API_KEY: 'POSTHOG_PERSONAL_API_KEY',

  // Optional overrides. The defaults above are used when these are absent.
  LOOKUP_TABLE: 'POSTHOG_GOODLEAP_LOOKUP_TABLE',
  FALLBACK_LOOKUP_TABLE: 'POSTHOG_ARTEMIS_SALES_LOOKUP_TABLE',
  FALLBACK_PROJECTS_TABLE: 'POSTHOG_ARTEMIS_SALES_PROJECTS_TABLE',
  FALLBACK_ORGANIZATIONS_TABLE:
    'POSTHOG_ARTEMIS_SALES_ORGANIZATIONS_TABLE',
  MAP_SOURCE_TABLE: 'POSTHOG_GOODLEAP_PROJECT_MAP_SOURCES_TABLE',
  FALLBACK_MAP_SOURCE_TABLE:
    'POSTHOG_ARTEMIS_SALES_PROJECT_MAP_SOURCES_TABLE',
  APPLICATION_ID_FIELD: 'POSTHOG_APPLICATION_ID_FIELD',
  PROJECT_ID_FIELD: 'POSTHOG_GOODLEAP_PROJECT_ID_FIELD',
  SOURCE_UPDATED_AT_FIELD: 'POSTHOG_SOURCE_UPDATED_AT_FIELD',
  PROJECT_ORGANIZATION_ID_FIELD:
    'POSTHOG_ARTEMIS_SALES_PROJECT_ORGANIZATION_ID_FIELD',
  ORGANIZATION_NAME_FIELD: 'POSTHOG_ARTEMIS_SALES_ORGANIZATION_NAME_FIELD',
  MAP_SOURCE_PROJECT_ID_FIELD: 'POSTHOG_MAP_SOURCE_PROJECT_ID_FIELD',
  MAP_DATA_SOURCE_FIELD: 'POSTHOG_MAP_DATA_SOURCE_FIELD',
  RGB_BASEMAP_URL_FIELD: 'POSTHOG_RGB_BASEMAP_URL_FIELD',
  MAP_SOURCE_UPDATED_AT_FIELD: 'POSTHOG_MAP_SOURCE_UPDATED_AT_FIELD',
  PROJECT_URL_PREFIX: 'POSTHOG_PROJECT_URL_PREFIX',
  FALLBACK_PROJECT_URL_PREFIX: 'POSTHOG_ARTEMIS_SALES_PROJECT_URL_PREFIX',
  PROJECT_URL_SUFFIX: 'POSTHOG_PROJECT_URL_SUFFIX',
};

const POSTHOG_PROJECT_HEADERS = [
  'Application ID',
  'Project ID',
  'Organization',
  'Project URL',
  'Attachment Links',
  'Google Group URL',
  'Source Updated At',
  'Last Synced At',
  'Match Status',
  'Match Count',
  'Error',
];

const LEGACY_POSTHOG_PROJECT_HEADERS_V1 = [
  'Application ID',
  'Project ID',
  'Project URL',
  'Source Updated At',
  'Last Synced At',
  'Match Status',
  'Match Count',
  'Error',
];

const LEGACY_POSTHOG_PROJECT_HEADERS_V2 = [
  'Application ID',
  'Project ID',
  'Project URL',
  'Attachment Links',
  'Source Updated At',
  'Last Synced At',
  'Match Status',
  'Match Count',
  'Error',
];

const LEGACY_POSTHOG_PROJECT_HEADERS_V3 = [
  'Application ID',
  'Project ID',
  'Project URL',
  'Attachment Links',
  'Google Group URL',
  'Source Updated At',
  'Last Synced At',
  'Match Status',
  'Match Count',
  'Error',
];

/**
 * Validates configuration and creates the derived PostHog Projects sheet.
 * It is idempotent and can be run again safely.
 */
function setupPostHogProjectSync() {
  const settings = getPostHogSettings_();
  const resources = getOrCreateResources_();
  const sheet = getOrCreatePostHogProjectsSheet_(resources.spreadsheet);

  console.log('PostHog project sync setup completed.');
  console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Derived sheet: ${sheet.getName()}`);
  console.log(`PostHog host: ${settings.host}`);
  console.log(`PostHog environment ID: ${settings.projectId}`);
  console.log(`GoodLeap lookup table: ${settings.lookupTable}`);
  console.log(`Artemis Sales fallback table: ${settings.fallbackLookupTable}`);
  console.log(`Artemis Sales projects table: ${settings.fallbackProjectsTable}`);
  console.log(
    `Artemis Sales organizations table: ` +
    `${settings.fallbackOrganizationsTable}`,
  );
  console.log(`GoodLeap map source table: ${settings.mapSourceTable}`);
  console.log(
    `Artemis Sales map source table: ${settings.fallbackMapSourceTable}`,
  );
  console.log(`GoodLeap project URL prefix: ${settings.projectUrlPrefix}`);
  console.log(
    `Artemis Sales project URL prefix: ${settings.fallbackProjectUrlPrefix}`,
  );
  console.log(`Application ID field: ${settings.applicationIdField}`);
  console.log(`Project ID field: ${settings.projectIdField}`);
  console.log('The personal API key was found and was not logged.');

  return {
    spreadsheetUrl: resources.spreadsheet.getUrl(),
    sheetName: sheet.getName(),
    postHogHost: settings.host,
    postHogProjectId: settings.projectId,
    lookupTable: settings.lookupTable,
    fallbackLookupTable: settings.fallbackLookupTable,
    fallbackProjectsTable: settings.fallbackProjectsTable,
    fallbackOrganizationsTable: settings.fallbackOrganizationsTable,
    mapSourceTable: settings.mapSourceTable,
    fallbackMapSourceTable: settings.fallbackMapSourceTable,
    applicationIdField: settings.applicationIdField,
    projectIdField: settings.projectIdField,
  };
}

/**
 * Performs the smallest possible authenticated query. It does not write to
 * Sheets and never logs the personal API key.
 */
function testPostHogConnection() {
  const response = executePostHogHogQL_(
    'SELECT 1 AS connection_test',
    'goodleap_apps_script_connection_test',
  );

  const value = response.results.length > 0
    ? response.results[0][0]
    : null;

  if (Number(value) !== 1) {
    throw new Error(
      'PostHog accepted the request but returned an unexpected test result.',
    );
  }

  console.log('PostHog connection test passed.');
  console.log(`Returned columns: ${response.columns.join(', ')}`);
  return {ok: true, columns: response.columns};
}

/**
 * Reads one GoodLeap project only to obtain response column names. It logs
 * candidate identifiers but does not log row values or write to Sheets.
 */
function inspectPostHogGoodLeapProjectSchema() {
  const settings = getPostHogSettings_();
  const query = [
    'SELECT *',
    `FROM ${settings.lookupTable}`,
    'LIMIT 1',
  ].join('\n');

  const response = executePostHogHogQL_(
    query,
    'goodleap_apps_script_schema_inspection',
  );

  if (response.columns.length === 0) {
    throw new Error(
      'PostHog did not return column metadata for the GoodLeap lookup table.',
    );
  }

  const candidateColumns = response.columns.filter((column) =>
    /(^id$|application|external|financ|project.*id|updated_at)/i.test(column),
  );

  console.log(`Table: ${settings.lookupTable}`);
  console.log(`Total returned columns: ${response.columns.length}`);
  console.log(`Candidate mapping columns: ${candidateColumns.join(', ')}`);
  console.log(
    `Configured Application ID field: ${settings.applicationIdField}`,
  );
  console.log(`Configured Project ID field: ${settings.projectIdField}`);
  console.log('No project row values were logged.');

  return {
    table: settings.lookupTable,
    totalColumns: response.columns.length,
    candidateColumns,
    configuredApplicationIdField: settings.applicationIdField,
    configuredProjectIdField: settings.projectIdField,
  };
}

/**
 * Uses PostHog's DatabaseSchemaQuery to discover GoodLeap warehouse tables,
 * candidate Application ID fields, and configured joins. It reads metadata
 * only: it does not query or log customer/project row values and does not
 * write to Sheets.
 */
function inspectPostHogGoodLeapDatabaseSchema() {
  const catalog = executePostHogQueryNode_(
    {
      kind: 'DatabaseSchemaQuery',
      includeFields: false,
    },
    'goodleap_apps_script_database_catalog',
  );
  const catalogTables = catalog.tables || {};
  const allTableKeys = Object.keys(catalogTables);
  const goodLeapTableKeys = allTableKeys.filter((tableKey) => {
    const table = catalogTables[tableKey] || {};
    return /goodleap/i.test(`${tableKey} ${table.name || ''}`);
  });

  if (goodLeapTableKeys.length === 0) {
    throw new Error(
      'PostHog returned no GoodLeap tables in DatabaseSchemaQuery.',
    );
  }

  console.log(`GoodLeap schema tables found: ${goodLeapTableKeys.length}`);
  chunkPostHogArray_(goodLeapTableKeys.sort(), 20).forEach((tableBatch) => {
    console.log(`[GOODLEAP TABLES] ${tableBatch.join(', ')}`);
  });

  const detailedCatalog = executePostHogQueryNode_(
    {
      kind: 'DatabaseSchemaQuery',
      tables: goodLeapTableKeys,
      includeFields: true,
    },
    'goodleap_apps_script_database_schema_details',
  );
  const detailedTables = detailedCatalog.tables || {};
  const candidateFields = [];

  Object.keys(detailedTables).forEach((tableKey) => {
    const table = detailedTables[tableKey] || {};
    const fields = table.fields || {};

    Object.keys(fields).forEach((fieldKey) => {
      const field = fields[fieldKey] || {};
      const descriptor = [
        tableKey,
        table.name || '',
        fieldKey,
        field.name || '',
        field.hogql_value || '',
        field.table || '',
        Array.isArray(field.fields) ? field.fields.join(' ') : '',
      ].join(' ');

      if (/application|financ|loan|external.project/i.test(descriptor)) {
        candidateFields.push({
          table: tableKey,
          field: field.name || fieldKey,
          hogqlValue: field.hogql_value || '',
          type: field.type || '',
          linkedTable: field.table || '',
        });
      }
    });
  });

  const allJoins = Array.isArray(detailedCatalog.joins)
    ? detailedCatalog.joins
    : Array.isArray(catalog.joins)
      ? catalog.joins
      : [];
  const candidateJoins = allJoins.filter((join) =>
    /goodleap|financ|application|loan/i.test(JSON.stringify(join)),
  );

  if (candidateFields.length === 0) {
    console.log('[SCHEMA FIELD] No Application/Financier/Loan candidates found.');
  } else {
    candidateFields.slice(0, 200).forEach((candidate) => {
      console.log(`[SCHEMA FIELD] ${JSON.stringify(candidate)}`);
    });
  }

  if (candidateJoins.length === 0) {
    console.log('[SCHEMA JOIN] No GoodLeap/Financier join candidates found.');
  } else {
    candidateJoins.slice(0, 100).forEach((join) => {
      console.log(
        `[SCHEMA JOIN] ${truncatePostHogText_(JSON.stringify(join), 2000)}`,
      );
    });
  }

  const summary = {
    allTables: allTableKeys.length,
    goodLeapTables: goodLeapTableKeys.length,
    candidateFields: candidateFields.length,
    candidateJoins: candidateJoins.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    'Metadata inspection completed. Do not run syncPostHogProjects() until ' +
    'the Application ID mapping has been confirmed.',
  );

  return summary;
}

/**
 * Queries a small sample of Case IDs and logs the exact project matches.
 * This function is read-only and must be reviewed before the first sync.
 */
function previewPostHogProjectMatches() {
  const resources = getOrCreateResources_();
  const emailsSheet = resources.spreadsheet.getSheetByName(
    POSTHOG_SYNC_CONFIG.SOURCE_SHEET_NAME,
  );
  const applicationIds = loadUniquePostHogApplicationIds_(emailsSheet);

  if (applicationIds.length === 0) {
    throw new Error(
      'No Case IDs were found in the Emails sheet. Process Gmail first.',
    );
  }

  const sampleIds = applicationIds
    .filter((applicationId) => isSafePostHogApplicationId_(applicationId))
    .slice(0, POSTHOG_SYNC_CONFIG.PREVIEW_APPLICATION_ID_LIMIT);

  if (sampleIds.length === 0) {
    throw new Error('No safe Application IDs were available for the preview.');
  }

  const matches = fetchPostHogProjectMatches_(sampleIds);
  const matchesByApplicationId = groupPostHogMatches_(matches);

  sampleIds.forEach((applicationId) => {
    const applicationMatches = matchesByApplicationId.get(applicationId) || [];

    if (applicationMatches.length === 0) {
      console.log(`[NOT FOUND] ${applicationId}`);
      return;
    }

    applicationMatches.forEach((match) => {
      console.log(
        `[MATCH] ${applicationId} | ${match.projectId} | ` +
        `${match.organization || '[NO ORGANIZATION]'} | ${match.projectUrl} | ` +
        `${match.lookupSource}`,
      );
    });
  });

  const matchedApplicationIds = sampleIds.filter(
    (applicationId) => (matchesByApplicationId.get(applicationId) || []).length > 0,
  );

  const duplicateApplicationIds = sampleIds.filter(
    (applicationId) => (matchesByApplicationId.get(applicationId) || []).length > 1,
  );

  const summary = {
    sampledApplicationIds: sampleIds.length,
    matchedApplicationIds: matchedApplicationIds.length,
    notFoundApplicationIds: sampleIds.length - matchedApplicationIds.length,
    duplicateApplicationIds,
    matchedFromGoodLeap: new Set(
      matches
        .filter((match) => match.lookupSource === 'GoodLeap')
        .map((match) => match.applicationId),
    ).size,
    matchedFromArtemisSales: new Set(
      matches
        .filter((match) => match.lookupSource === 'Artemis Sales')
        .map((match) => match.applicationId),
    ).size,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (matchedApplicationIds.length === 0) {
    console.log(
      'STOP: no sample IDs matched. Do not run syncPostHogProjects(). ' +
      'Run inspectPostHogGoodLeapProjectSchema() and verify the mapping first.',
    );
  }

  return summary;
}

/**
 * Synchronizes every unique Case ID from Emails into PostHog Projects.
 * The destination is a derived sheet: its data rows are rewritten on each
 * successful run so stale duplicates cannot accumulate.
 */
function syncPostHogProjects() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is already running. This sync was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }

  try {
    const resources = getOrCreateResources_();
    const emailsSheet = resources.spreadsheet.getSheetByName(
      POSTHOG_SYNC_CONFIG.SOURCE_SHEET_NAME,
    );
    const attachmentsSheet = resources.spreadsheet.getSheetByName(
      POSTHOG_SYNC_CONFIG.ATTACHMENTS_SHEET_NAME,
    );
    const projectsSheet = getOrCreatePostHogProjectsSheet_(
      resources.spreadsheet,
    );
    const applicationIds = loadUniquePostHogApplicationIds_(emailsSheet);
    const attachmentLinksByApplicationId =
      loadPostHogAttachmentLinks_(attachmentsSheet);
    const googleGroupLinksByApplicationId =
      loadPostHogGoogleGroupLinks_(emailsSheet);

    if (applicationIds.length === 0) {
      console.log('No Case IDs were found. Nothing was synchronized.');
      return {applicationIds: 0, matched: 0, notFound: 0, errors: 0};
    }

    if (
      applicationIds.length >
      POSTHOG_SYNC_CONFIG.MAX_APPLICATION_IDS_PER_SYNC
    ) {
      throw new Error(
        `The sync found ${applicationIds.length} Application IDs, exceeding ` +
        `the safety limit of ${POSTHOG_SYNC_CONFIG.MAX_APPLICATION_IDS_PER_SYNC}.`,
      );
    }

    const previousRows = loadExistingPostHogProjectRows_(projectsSheet);
    const validIds = [];
    const invalidIdErrors = new Map();

    applicationIds.forEach((applicationId) => {
      if (isSafePostHogApplicationId_(applicationId)) {
        validIds.push(applicationId);
      } else {
        invalidIdErrors.set(
          applicationId,
          'Application ID contains unsupported characters or is too long.',
        );
      }
    });

    const matchesByApplicationId = new Map();
    const queryErrorsByApplicationId = new Map();

    chunkPostHogArray_(validIds, POSTHOG_SYNC_CONFIG.QUERY_BATCH_SIZE)
      .forEach((batch) => {
        try {
          const batchMatches = fetchPostHogProjectMatches_(batch);
          const groupedBatchMatches = groupPostHogMatches_(batchMatches);

          batch.forEach((applicationId) => {
            matchesByApplicationId.set(
              applicationId,
              groupedBatchMatches.get(applicationId) || [],
            );
          });
        } catch (error) {
          const safeError = truncatePostHogText_(String(error), 1000);
          batch.forEach((applicationId) => {
            queryErrorsByApplicationId.set(applicationId, safeError);
          });
          console.error(`[POSTHOG BATCH ERROR] ${safeError}`);
        }
      });

    const syncedAt = new Date();
    const stats = {
      applicationIds: applicationIds.length,
      matched: 0,
      matchedFromGoodLeap: 0,
      matchedFromArtemisSales: 0,
      matchedWithoutOrganization: 0,
      multipleMatches: 0,
      notFound: 0,
      errors: 0,
    };

    const outputRows = applicationIds.map((applicationId) => {
      const previous = previousRows.get(applicationId) || null;
      const attachmentLinks =
        attachmentLinksByApplicationId.get(applicationId) || [];
      const attachmentText = buildPostHogAttachmentText_(attachmentLinks);
      const googleGroupLinks =
        googleGroupLinksByApplicationId.get(applicationId) || [];
      const googleGroupText = buildPostHogGoogleGroupText_(googleGroupLinks);
      const validationError = invalidIdErrors.get(applicationId) || '';
      const queryError = queryErrorsByApplicationId.get(applicationId) || '';
      const error = validationError || queryError;

      if (error) {
        stats.errors += 1;
        return buildPostHogOutputRow_(
          applicationId,
          previous ? previous.projectId : '',
          previous ? previous.organization : '',
          previous ? previous.projectUrl : '',
          attachmentText,
          googleGroupText,
          previous ? previous.sourceUpdatedAt : '',
          syncedAt,
          'Error',
          previous ? previous.matchCount : 0,
          error,
        );
      }

      const matches = matchesByApplicationId.get(applicationId) || [];

      if (matches.length === 0) {
        stats.notFound += 1;
        return buildPostHogOutputRow_(
          applicationId,
          '',
          '',
          '',
          attachmentText,
          googleGroupText,
          '',
          syncedAt,
          'Not Found',
          0,
          '',
        );
      }

      if (matches.length === 1) {
        stats.matched += 1;
        if (matches[0].lookupSource === 'Artemis Sales') {
          stats.matchedFromArtemisSales += 1;
        } else {
          stats.matchedFromGoodLeap += 1;
        }
        if (!matches[0].organization) {
          stats.matchedWithoutOrganization += 1;
          console.warn(`[ORGANIZATION NOT FOUND] ${applicationId}`);
        }
        return buildPostHogOutputRow_(
          applicationId,
          matches[0].projectId,
          matches[0].organization,
          matches[0].projectUrl,
          attachmentText,
          googleGroupText,
          matches[0].sourceUpdatedAt,
          syncedAt,
          'Matched',
          1,
          '',
        );
      }

      stats.multipleMatches += 1;
      if (matches.some((match) => !match.organization)) {
        stats.matchedWithoutOrganization += 1;
        console.warn(`[ORGANIZATION NOT FOUND] ${applicationId}`);
      }
      return buildPostHogOutputRow_(
        applicationId,
        matches.map((match) => match.projectId).join('\n'),
        matches.map((match) => match.organization).join('\n'),
        matches.map((match) => match.projectUrl).join('\n'),
        attachmentText,
        googleGroupText,
        matches[0].sourceUpdatedAt,
        syncedAt,
        'Multiple Matches',
        matches.length,
        'Review this Application ID before using a Project ID.',
      );
    });

    rewritePostHogProjectRows_(projectsSheet, outputRows);
    applyPostHogAttachmentLinks_(
      projectsSheet,
      applicationIds,
      attachmentLinksByApplicationId,
    );
    applyPostHogGoogleGroupLinks_(
      projectsSheet,
      applicationIds,
      googleGroupLinksByApplicationId,
    );
    stats.analysisProjectIds = syncPostHogProjectIdsToAnalysisSheets_(
      resources.spreadsheet,
    );
    if (typeof syncPostHogSolarTablesForResources_ === 'function') {
      try {
        stats.projectSolarTables = syncPostHogSolarTablesForResources_(
          resources,
        );
      } catch (error) {
        const safeSolarError = truncatePostHogText_(String(error), 1000);
        stats.projectSolarTables = {error: safeSolarError};
        console.error(`[PROJECT SOLAR SYNC ERROR] ${safeSolarError}`);
      }
    }
    if (typeof syncTOFValuesComparisonsSafely_ === 'function') {
      stats.tofValuesComparison = syncTOFValuesComparisonsSafely_(
        resources.spreadsheet,
      );
    }
    if (typeof refreshProjectIdSummarySafely_ === 'function') {
      stats.projectIdSummary = refreshProjectIdSummarySafely_(
        resources.spreadsheet,
        {refreshMapData: true},
      );
    }
    SpreadsheetApp.flush();

    console.log(JSON.stringify(stats, null, 2));
    console.log(`Spreadsheet: ${resources.spreadsheet.getUrl()}`);
    console.log(`Derived sheet: ${projectsSheet.getName()}`);
    return stats;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Refreshes Project ID in AI Analysis and PDF Analysis from the current
 * PostHog Projects sheet without making a PostHog or OpenAI API request.
 */
function syncProjectIdsToAnalysisSheets() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log(
      'Another GoodLeap execution is running. Project ID refresh was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }
  try {
    const resources = getOrCreateResources_();
    const stats = syncPostHogProjectIdsToAnalysisSheets_(
      resources.spreadsheet,
    );
    if (typeof refreshProjectIdSummarySafely_ === 'function') {
      stats.projectIdSummary = refreshProjectIdSummarySafely_(
        resources.spreadsheet,
        {refreshMapData: true},
      );
    }
    SpreadsheetApp.flush();
    console.log(JSON.stringify(stats, null, 2));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

function syncPostHogProjectIdsToAnalysisSheets_(spreadsheet) {
  const stats = {
    aiAnalysis: {sheetMissing: true},
    pdfAnalysis: {sheetMissing: true},
  };
  if (typeof syncOpenAIAnalysisProjectIdsFromPostHog_ === 'function') {
    stats.aiAnalysis = syncOpenAIAnalysisProjectIdsFromPostHog_(spreadsheet);
  }
  if (typeof syncOpenAIPdfProjectIdsFromPostHog_ === 'function') {
    stats.pdfAnalysis = syncOpenAIPdfProjectIdsFromPostHog_(spreadsheet);
  }
  return stats;
}

/**
 * Runs from the integrated five-minute trigger. After each successful Gmail
 * check, the coordinator processes bounded batches of pending OpenAI email
 * analyses and Shade Report PDF extractions.
 * This safely picks up a message that was skipped because another execution
 * held the lock. PostHog is refreshed only when at least one new message was
 * archived. OpenAI failures cannot prevent the PostHog step. The separate
 * hourly trigger retries delayed warehouse records and reconciles mappings.
 */
function processRecentGoodLeapEmailsAndSyncPostHog() {
  const gmailStats = processRecentGoodLeapEmails();

  if (!gmailStats || gmailStats.skippedBecauseLocked) {
    console.log(
      'Immediate PostHog sync skipped because Gmail processing did not run.',
    );
    return {
      gmail: gmailStats || null,
      openAI: null,
      openAIPdf: null,
      postHog: null,
      postHogSkipped: true,
    };
  }

  const openAIStats = analyzeRecentGoodLeapEmailsWithOpenAI();
  const openAIPdfStats = processRecentShadeReportPdfsWithOpenAI();

  if (Number(gmailStats.messagesProcessed || 0) === 0) {
    console.log(
      'No new Gmail messages were archived. Immediate PostHog sync skipped.',
    );
    return {
      gmail: gmailStats,
      openAI: openAIStats,
      openAIPdf: openAIPdfStats,
      postHog: null,
      postHogSkipped: true,
    };
  }

  console.log(
    `${gmailStats.messagesProcessed} new message(s) archived. ` +
    'Starting immediate PostHog synchronization.',
  );
  const postHogStats = syncPostHogProjects();

  return {
    gmail: gmailStats,
    openAI: openAIStats,
    openAIPdf: openAIPdfStats,
    postHog: postHogStats,
    postHogSkipped: false,
  };
}

/**
 * Replaces all legacy or duplicate workflow triggers with exactly two:
 *   1) integrated Gmail + conditional PostHog processing every five minutes;
 *   2) a full PostHog reconciliation every hour.
 *
 * Setup is validated before existing triggers are removed. The function is
 * idempotent and is the recommended migration path after PostHog validation.
 */
function installHybridGoodLeapPostHogTriggers() {
  setupGoodLeapArchive();
  setupPostHogProjectSync();
  if (typeof setupPostHogSolarTableSync === 'function') {
    setupPostHogSolarTableSync();
  }

  const managedHandlers = new Set(
    GOODLEAP_FIVE_MINUTE_TRIGGER_HANDLERS.concat(['syncPostHogProjects']),
  );
  let removed = 0;

  ScriptApp.getProjectTriggers()
    .filter((trigger) => managedHandlers.has(trigger.getHandlerFunction()))
    .forEach((trigger) => {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    });

  ScriptApp.newTrigger('processRecentGoodLeapEmailsAndSyncPostHog')
    .timeBased()
    .everyMinutes(5)
    .create();

  ScriptApp.newTrigger('syncPostHogProjects')
    .timeBased()
    .everyHours(POSTHOG_SYNC_CONFIG.TRIGGER_EVERY_HOURS)
    .create();

  console.log(`Managed triggers replaced: ${removed}.`);
  console.log(
    'Trigger installed: processRecentGoodLeapEmailsAndSyncPostHog every 5 minutes.',
  );
  console.log(
    `Trigger installed: syncPostHogProjects every ` +
    `${POSTHOG_SYNC_CONFIG.TRIGGER_EVERY_HOURS} hour(s).`,
  );

  return {
    removedTriggers: removed,
    fiveMinuteHandler: 'processRecentGoodLeapEmailsAndSyncPostHog',
    hourlyHandler: 'syncPostHogProjects',
  };
}

/**
 * Installs one hourly trigger. Run it only after the preview and first manual
 * sync have produced the expected mapping.
 */
function installPostHogSyncTrigger() {
  setupPostHogProjectSync();

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncPostHogProjects')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('syncPostHogProjects')
    .timeBased()
    .everyHours(POSTHOG_SYNC_CONFIG.TRIGGER_EVERY_HOURS)
    .create();

  console.log(
    `Trigger installed: syncPostHogProjects every ` +
    `${POSTHOG_SYNC_CONFIG.TRIGGER_EVERY_HOURS} hour(s).`,
  );
}

/**
 * Removes only the PostHog synchronization trigger. It does not delete data,
 * credentials, the sheet, or the Gmail processing trigger.
 */
function removePostHogSyncTrigger() {
  let removed = 0;

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncPostHogProjects')
    .forEach((trigger) => {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    });

  console.log(`PostHog sync triggers removed: ${removed}`);
}

function getPostHogSettings_() {
  const properties = PropertiesService.getScriptProperties();
  const host = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.HOST) || '',
  )
    .trim()
    .replace(/\/+$/, '');
  const projectId = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.PROJECT_ID) || '',
  ).trim();
  const personalApiKey = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.PERSONAL_API_KEY) || '',
  ).trim();
  const lookupTable = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.LOOKUP_TABLE) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_LOOKUP_TABLE,
  ).trim();
  const fallbackLookupTable = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.FALLBACK_LOOKUP_TABLE) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_FALLBACK_LOOKUP_TABLE,
  ).trim();
  const fallbackProjectsTable = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.FALLBACK_PROJECTS_TABLE) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_FALLBACK_PROJECTS_TABLE,
  ).trim();
  const fallbackOrganizationsTable = String(
    properties.getProperty(
      POSTHOG_PROPERTY_KEYS.FALLBACK_ORGANIZATIONS_TABLE,
    ) || POSTHOG_SYNC_CONFIG.DEFAULT_FALLBACK_ORGANIZATIONS_TABLE,
  ).trim();
  const mapSourceTable = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.MAP_SOURCE_TABLE) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_MAP_SOURCE_TABLE,
  ).trim();
  const fallbackMapSourceTable = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.FALLBACK_MAP_SOURCE_TABLE) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_FALLBACK_MAP_SOURCE_TABLE,
  ).trim();
  const applicationIdField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.APPLICATION_ID_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_APPLICATION_ID_FIELD,
  ).trim();
  const projectIdField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.PROJECT_ID_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_PROJECT_ID_FIELD,
  ).trim();
  const sourceUpdatedAtField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.SOURCE_UPDATED_AT_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_SOURCE_UPDATED_AT_FIELD,
  ).trim();
  const projectOrganizationIdField = String(
    properties.getProperty(
      POSTHOG_PROPERTY_KEYS.PROJECT_ORGANIZATION_ID_FIELD,
    ) || POSTHOG_SYNC_CONFIG.DEFAULT_PROJECT_ORGANIZATION_ID_FIELD,
  ).trim();
  const organizationNameField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.ORGANIZATION_NAME_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_ORGANIZATION_NAME_FIELD,
  ).trim();
  const mapSourceProjectIdField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.MAP_SOURCE_PROJECT_ID_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_MAP_SOURCE_PROJECT_ID_FIELD,
  ).trim();
  const mapDataSourceField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.MAP_DATA_SOURCE_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_MAP_DATA_SOURCE_FIELD,
  ).trim();
  const rgbBasemapUrlField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.RGB_BASEMAP_URL_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_RGB_BASEMAP_URL_FIELD,
  ).trim();
  const mapSourceUpdatedAtField = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.MAP_SOURCE_UPDATED_AT_FIELD) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_MAP_SOURCE_UPDATED_AT_FIELD,
  ).trim();
  const projectUrlPrefix = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.PROJECT_URL_PREFIX) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_PROJECT_URL_PREFIX,
  ).trim();
  const fallbackProjectUrlPrefix = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.FALLBACK_PROJECT_URL_PREFIX) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_FALLBACK_PROJECT_URL_PREFIX,
  ).trim();
  const projectUrlSuffix = String(
    properties.getProperty(POSTHOG_PROPERTY_KEYS.PROJECT_URL_SUFFIX) ||
      POSTHOG_SYNC_CONFIG.DEFAULT_PROJECT_URL_SUFFIX,
  ).trim();

  const missing = [];
  if (!host) missing.push(POSTHOG_PROPERTY_KEYS.HOST);
  if (!projectId) missing.push(POSTHOG_PROPERTY_KEYS.PROJECT_ID);
  if (!personalApiKey) missing.push(POSTHOG_PROPERTY_KEYS.PERSONAL_API_KEY);

  if (missing.length > 0) {
    throw new Error(
      `Missing Script Properties: ${missing.join(', ')}. ` +
      'Add them in Apps Script Project Settings.',
    );
  }

  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) {
    throw new Error(
      `${POSTHOG_PROPERTY_KEYS.HOST} must be an HTTPS origin without a path.`,
    );
  }

  if (!/^\d+$/.test(projectId)) {
    throw new Error(
      `${POSTHOG_PROPERTY_KEYS.PROJECT_ID} must be the numeric PostHog ` +
      'environment ID.',
    );
  }

  [
    lookupTable,
    fallbackLookupTable,
    fallbackProjectsTable,
    fallbackOrganizationsTable,
    mapSourceTable,
    fallbackMapSourceTable,
  ].forEach((table) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) {
      throw new Error(
        `The configured PostHog lookup table is not a safe identifier: ${table}.`,
      );
    }
  });

  [
    applicationIdField,
    projectIdField,
    sourceUpdatedAtField,
    projectOrganizationIdField,
    organizationNameField,
    mapSourceProjectIdField,
    mapDataSourceField,
    rgbBasemapUrlField,
    mapSourceUpdatedAtField,
  ].forEach((field) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
      throw new Error(`The configured PostHog field is not safe: ${field}.`);
    }
  });

  [projectUrlPrefix, fallbackProjectUrlPrefix].forEach((prefix) => {
    if (!/^https:\/\//i.test(prefix)) {
      throw new Error(
        `The PostHog project URL prefix must start with HTTPS: ${prefix}.`,
      );
    }
  });

  if (!/^\/[A-Za-z0-9/_-]*$/.test(projectUrlSuffix)) {
    throw new Error('The PostHog project URL suffix must be a safe URL path.');
  }

  return {
    host,
    projectId,
    personalApiKey,
    lookupTable,
    fallbackLookupTable,
    fallbackProjectsTable,
    fallbackOrganizationsTable,
    mapSourceTable,
    fallbackMapSourceTable,
    applicationIdField,
    projectIdField,
    sourceUpdatedAtField,
    projectOrganizationIdField,
    organizationNameField,
    mapSourceProjectIdField,
    mapDataSourceField,
    rgbBasemapUrlField,
    mapSourceUpdatedAtField,
    projectUrlPrefix,
    fallbackProjectUrlPrefix,
    projectUrlSuffix,
  };
}

function getOrCreatePostHogProjectsSheet_(spreadsheet) {
  migratePostHogProjectsSheetSchema_(spreadsheet);

  const sheet = getOrCreateSheet_(
    spreadsheet,
    POSTHOG_SYNC_CONFIG.SHEET_NAME,
    POSTHOG_PROJECT_HEADERS,
  );

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 280);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 420);
  sheet.setColumnWidth(5, 420);
  sheet.setColumnWidth(6, 420);
  sheet.setColumnWidth(7, 170);
  sheet.setColumnWidth(8, 170);
  sheet.setColumnWidth(9, 150);
  sheet.setColumnWidth(10, 100);
  sheet.setColumnWidth(11, 420);
  sheet.getRange('G:H').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('B:F').setWrap(true);
  sheet.getRange('K:K').setWrap(true);

  return sheet;
}

/**
 * Upgrades any supported legacy layout to the current derived schema. The
 * exact legacy header sequence must match before any structural change is
 * made, so rerunning setup cannot insert duplicate columns.
 */
function migratePostHogProjectsSheetSchema_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(POSTHOG_SYNC_CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() === 0) {
    return;
  }

  const headerCount = Math.max(
    LEGACY_POSTHOG_PROJECT_HEADERS_V3.length,
    Math.min(sheet.getLastColumn(), POSTHOG_PROJECT_HEADERS.length),
  );
  const existingHeaders = sheet
    .getRange(1, 1, 1, headerCount)
    .getDisplayValues()[0];
  const alreadyCurrent = POSTHOG_PROJECT_HEADERS.every(
    (header, index) => existingHeaders[index] === header,
  );

  if (alreadyCurrent) {
    return;
  }

  const isLegacyV3 = LEGACY_POSTHOG_PROJECT_HEADERS_V3.every(
    (header, index) => existingHeaders[index] === header,
  );

  if (isLegacyV3) {
    sheet.insertColumnBefore(3);
    formatPostHogHeaderCell_(sheet.getRange(1, 3), 'Organization');
    console.log(
      'PostHog Projects schema upgraded: Organization was inserted as column C.',
    );
    return;
  }

  const isLegacyV2 = LEGACY_POSTHOG_PROJECT_HEADERS_V2.every(
    (header, index) => existingHeaders[index] === header,
  );

  if (isLegacyV2) {
    sheet.insertColumnBefore(3);
    formatPostHogHeaderCell_(sheet.getRange(1, 3), 'Organization');
    sheet.insertColumnBefore(6);
    formatPostHogHeaderCell_(sheet.getRange(1, 6), 'Google Group URL');
    console.log(
      'PostHog Projects schema upgraded: Organization and Google Group URL ' +
      'were inserted as columns C and F.',
    );
    return;
  }

  const isLegacyV1 = LEGACY_POSTHOG_PROJECT_HEADERS_V1.every(
    (header, index) => existingHeaders[index] === header,
  );

  if (!isLegacyV1) {
    return;
  }

  sheet.insertColumnBefore(3);
  formatPostHogHeaderCell_(sheet.getRange(1, 3), 'Organization');
  sheet.insertColumnBefore(5);
  formatPostHogHeaderCell_(sheet.getRange(1, 5), 'Attachment Links');
  sheet.insertColumnBefore(6);
  formatPostHogHeaderCell_(sheet.getRange(1, 6), 'Google Group URL');
  console.log(
    'PostHog Projects schema upgraded: Organization, Attachment Links, and ' +
    'Google Group URL were inserted as columns C, E, and F.',
  );
}

function formatPostHogHeaderCell_(range, value) {
  range
    .setValue(value)
    .setFontWeight('bold')
    .setBackground('#6e04bd')
    .setFontColor('#ffffff');
}

function loadUniquePostHogApplicationIds_(emailsSheet) {
  if (!emailsSheet) {
    throw new Error(
      `Required sheet not found: ${POSTHOG_SYNC_CONFIG.SOURCE_SHEET_NAME}.`,
    );
  }

  if (emailsSheet.getLastRow() < 2) {
    return [];
  }

  const headers = emailsSheet
    .getRange(1, 1, 1, emailsSheet.getLastColumn())
    .getDisplayValues()[0];
  const columnIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.SOURCE_APPLICATION_ID_HEADER,
  );

  if (columnIndex < 0) {
    throw new Error(
      `Header not found in Emails: ` +
      `${POSTHOG_SYNC_CONFIG.SOURCE_APPLICATION_ID_HEADER}.`,
    );
  }

  const values = emailsSheet
    .getRange(2, columnIndex + 1, emailsSheet.getLastRow() - 1, 1)
    .getDisplayValues();
  const uniqueIds = new Set();

  values.forEach((row) => {
    const applicationId = String(row[0] || '').trim();
    if (applicationId && applicationId !== 'NO_CASE_ID') {
      uniqueIds.add(applicationId);
    }
  });

  return Array.from(uniqueIds).sort();
}

/**
 * Groups every saved Drive attachment by Case ID. Column positions are found
 * from their headers so the lookup does not depend on hard-coded indexes.
 */
function loadPostHogAttachmentLinks_(attachmentsSheet) {
  if (!attachmentsSheet) {
    throw new Error(
      `Required sheet not found: ${POSTHOG_SYNC_CONFIG.ATTACHMENTS_SHEET_NAME}.`,
    );
  }

  if (attachmentsSheet.getLastRow() < 2) {
    return new Map();
  }

  const headers = attachmentsSheet
    .getRange(1, 1, 1, attachmentsSheet.getLastColumn())
    .getDisplayValues()[0];
  const applicationIdIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.ATTACHMENT_APPLICATION_ID_HEADER,
  );
  const filenameIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.ATTACHMENT_FILENAME_HEADER,
  );
  const urlIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.ATTACHMENT_URL_HEADER,
  );
  const requiredIndexes = [applicationIdIndex, filenameIndex, urlIndex];

  if (requiredIndexes.some((index) => index < 0)) {
    throw new Error(
      'The Attachments sheet is missing one or more required headers: ' +
      `${POSTHOG_SYNC_CONFIG.ATTACHMENT_APPLICATION_ID_HEADER}, ` +
      `${POSTHOG_SYNC_CONFIG.ATTACHMENT_FILENAME_HEADER}, ` +
      `${POSTHOG_SYNC_CONFIG.ATTACHMENT_URL_HEADER}.`,
    );
  }

  const values = attachmentsSheet
    .getRange(
      2,
      1,
      attachmentsSheet.getLastRow() - 1,
      attachmentsSheet.getLastColumn(),
    )
    .getDisplayValues();
  const linksByApplicationId = new Map();
  const seenUrlsByApplicationId = new Map();

  values.forEach((row) => {
    const applicationId = String(row[applicationIdIndex] || '').trim();
    const url = String(row[urlIndex] || '').trim();

    if (
      !applicationId ||
      applicationId === 'NO_CASE_ID' ||
      !/^https:\/\//i.test(url)
    ) {
      return;
    }

    if (!linksByApplicationId.has(applicationId)) {
      linksByApplicationId.set(applicationId, []);
      seenUrlsByApplicationId.set(applicationId, new Set());
    }

    const seenUrls = seenUrlsByApplicationId.get(applicationId);
    if (seenUrls.has(url)) {
      return;
    }

    seenUrls.add(url);
    const filename = sanitizePostHogAttachmentLabel_(
      row[filenameIndex],
      linksByApplicationId.get(applicationId).length + 1,
    );
    linksByApplicationId.get(applicationId).push({filename, url});
  });

  return linksByApplicationId;
}

/**
 * Groups Google Groups URLs from Emails by Case ID. Exact conversation URLs
 * take precedence over search fallbacks. Duplicate URLs are removed.
 */
function loadPostHogGoogleGroupLinks_(emailsSheet) {
  if (!emailsSheet) {
    throw new Error(
      `Required sheet not found: ${POSTHOG_SYNC_CONFIG.SOURCE_SHEET_NAME}.`,
    );
  }

  if (emailsSheet.getLastRow() < 2) {
    return new Map();
  }

  const headers = emailsSheet
    .getRange(1, 1, 1, emailsSheet.getLastColumn())
    .getDisplayValues()[0];
  const applicationIdIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.SOURCE_APPLICATION_ID_HEADER,
  );
  const groupUrlIndex = headers.indexOf(
    POSTHOG_SYNC_CONFIG.SOURCE_GOOGLE_GROUP_URL_HEADER,
  );

  if (applicationIdIndex < 0 || groupUrlIndex < 0) {
    throw new Error(
      'The Emails sheet is missing one or more required headers: ' +
      `${POSTHOG_SYNC_CONFIG.SOURCE_APPLICATION_ID_HEADER}, ` +
      `${POSTHOG_SYNC_CONFIG.SOURCE_GOOGLE_GROUP_URL_HEADER}.`,
    );
  }

  const values = emailsSheet
    .getRange(
      2,
      1,
      emailsSheet.getLastRow() - 1,
      emailsSheet.getLastColumn(),
    )
    .getDisplayValues();
  const exactUrlsByApplicationId = new Map();
  const fallbackUrlsByApplicationId = new Map();

  values.forEach((row) => {
    const applicationId = String(row[applicationIdIndex] || '').trim();
    const url = String(row[groupUrlIndex] || '').trim();

    if (
      !applicationId ||
      applicationId === 'NO_CASE_ID' ||
      !/^https:\/\//i.test(url)
    ) {
      return;
    }

    const targetMap = isExactPostHogGoogleGroupUrl_(url)
      ? exactUrlsByApplicationId
      : fallbackUrlsByApplicationId;
    if (!targetMap.has(applicationId)) {
      targetMap.set(applicationId, new Set());
    }
    targetMap.get(applicationId).add(url);
  });

  const linksByApplicationId = new Map();
  const applicationIds = new Set(
    Array.from(exactUrlsByApplicationId.keys()).concat(
      Array.from(fallbackUrlsByApplicationId.keys()),
    ),
  );

  applicationIds.forEach((applicationId) => {
    const exactUrls = exactUrlsByApplicationId.get(applicationId);
    const selectedUrls = exactUrls && exactUrls.size > 0
      ? exactUrls
      : fallbackUrlsByApplicationId.get(applicationId) || new Set();
    linksByApplicationId.set(
      applicationId,
      Array.from(selectedUrls).map((url) => ({url})),
    );
  });

  return linksByApplicationId;
}

function isExactPostHogGoogleGroupUrl_(url) {
  return /\/c\/[A-Za-z0-9_-]+(?:[/?#]|$)/i.test(String(url || ''));
}

function fetchPostHogProjectMatches_(applicationIds) {
  if (applicationIds.length === 0) {
    return [];
  }

  const settings = getPostHogSettings_();
  const primaryMatches = fetchPostHogProjectMatchesFromTable_(
    applicationIds,
    settings.lookupTable,
    'GoodLeap',
    'goodleap_apps_script_project_lookup',
    settings.projectUrlPrefix,
    settings,
  );
  const primaryMatchesByApplicationId = groupPostHogMatches_(primaryMatches);
  const fallbackApplicationIds = applicationIds.filter(
    (applicationId) =>
      (primaryMatchesByApplicationId.get(applicationId) || []).length === 0,
  );

  if (fallbackApplicationIds.length === 0) {
    return primaryMatches;
  }

  const fallbackMatches = fetchPostHogProjectMatchesFromTable_(
    fallbackApplicationIds,
    settings.fallbackLookupTable,
    'Artemis Sales',
    'artemis_sales_apps_script_project_lookup',
    settings.fallbackProjectUrlPrefix,
    settings,
  );

  return primaryMatches.concat(fallbackMatches);
}

/**
 * Queries one confirmed financier table. The caller sends only IDs that have
 * not matched a higher-priority source, so GoodLeap always wins and Artemis
 * Sales is used strictly as a fallback.
 */
function fetchPostHogProjectMatchesFromTable_(
  applicationIds,
  lookupTable,
  lookupSource,
  queryName,
  projectUrlPrefix,
  settings,
) {
  const isArtemisSales = lookupSource === 'Artemis Sales';
  const organizationExpression = isArtemisSales
    ? `toString(o.${settings.organizationNameField})`
    : postHogStringLiteral_('GoodLeap');
  const joinLines = isArtemisSales
    ? [
      `LEFT JOIN ${settings.fallbackProjectsTable} AS p ` +
        `ON toString(p.id) = toString(f.${settings.projectIdField})`,
      `LEFT JOIN ${settings.fallbackOrganizationsTable} AS o ` +
        `ON toString(o.id) = ` +
        `toString(p.${settings.projectOrganizationIdField})`,
    ]
    : [];
  const literals = applicationIds
    .map((applicationId) => postHogStringLiteral_(applicationId))
    .join(', ');
  const limit = Math.min(
    POSTHOG_SYNC_CONFIG.MAX_MATCHES_PER_BATCH,
    Math.max(applicationIds.length * 10, applicationIds.length),
  );
  const query = [
    'SELECT',
    `  toString(f.${settings.applicationIdField}) AS application_id,`,
    `  toString(f.${settings.projectIdField}) AS project_id,`,
    `  ${organizationExpression} AS organization_name,`,
    `  concat(${postHogStringLiteral_(projectUrlPrefix)}, ` +
      `toString(f.${settings.projectIdField}), ` +
      `${postHogStringLiteral_(settings.projectUrlSuffix)}) ` +
      'AS project_url,',
    `  f.${settings.sourceUpdatedAtField} AS source_updated_at`,
    `FROM ${lookupTable} AS f`,
    ...joinLines,
    `WHERE toString(f.${settings.applicationIdField}) IN (${literals})`,
    `ORDER BY toString(f.${settings.applicationIdField}), ` +
      `f.${settings.sourceUpdatedAtField} DESC, ` +
      `toString(f.${settings.projectIdField})`,
    `LIMIT ${limit}`,
  ].join('\n');

  const response = executePostHogHogQL_(
    query,
    queryName,
  );

  return parsePostHogProjectMatches_(response).map((match) => ({
    ...match,
    lookupSource,
  }));
}

function executePostHogHogQL_(query, queryName) {
  const data = executePostHogQueryNode_(
    {
      kind: 'HogQLQuery',
      query,
    },
    queryName,
  );

  if (!Array.isArray(data.results)) {
    throw new Error(
      'PostHog did not return a synchronous results array. Try the query again.',
    );
  }

  return {
    columns: normalizePostHogColumns_(data.columns),
    results: data.results,
    isCached: Boolean(data.is_cached),
  };
}

function executePostHogQueryNode_(queryNode, queryName) {
  const settings = getPostHogSettings_();
  const url =
    `${settings.host}/api/projects/${encodeURIComponent(settings.projectId)}/query/`;
  const payload = {
    query: queryNode,
    name: queryName,
    refresh: 'force_blocking',
  };
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${settings.personalApiKey}`,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  let data = null;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(
      `PostHog returned non-JSON content (HTTP ${statusCode}).`,
    );
  }

  if (statusCode < 200 || statusCode >= 300) {
    const detail =
      data.detail || data.error || data.message || responseText || 'Unknown error';
    throw new Error(
      `PostHog query failed (HTTP ${statusCode}): ` +
      `${truncatePostHogText_(String(detail), 1000)}`,
    );
  }

  return data;
}

function normalizePostHogColumns_(columns) {
  if (!Array.isArray(columns)) {
    return [];
  }

  return columns.map((column, index) => {
    if (typeof column === 'string') {
      return column;
    }
    if (column && typeof column.name === 'string') {
      return column.name;
    }
    return `column_${index + 1}`;
  });
}

function parsePostHogProjectMatches_(response) {
  const normalizedColumns = response.columns.map((column) =>
    String(column).toLowerCase(),
  );
  const applicationIdIndex = normalizedColumns.indexOf('application_id');
  const projectIdIndex = normalizedColumns.indexOf('project_id');
  const organizationNameIndex = normalizedColumns.indexOf('organization_name');
  const projectUrlIndex = normalizedColumns.indexOf('project_url');
  const sourceUpdatedAtIndex = normalizedColumns.indexOf('source_updated_at');

  if (
    applicationIdIndex < 0 ||
    projectIdIndex < 0 ||
    organizationNameIndex < 0 ||
    projectUrlIndex < 0 ||
    sourceUpdatedAtIndex < 0
  ) {
    throw new Error(
      `Unexpected PostHog response columns: ${response.columns.join(', ')}.`,
    );
  }

  return response.results.map((row) => ({
    applicationId: String(row[applicationIdIndex] || '').trim(),
    projectId: String(row[projectIdIndex] || '').trim(),
    organization: String(row[organizationNameIndex] || '').trim(),
    projectUrl: String(row[projectUrlIndex] || '').trim(),
    sourceUpdatedAt: parsePostHogDate_(row[sourceUpdatedAtIndex]),
  }));
}

function groupPostHogMatches_(matches) {
  const grouped = new Map();

  matches.forEach((match) => {
    if (!match.applicationId || !match.projectId) {
      return;
    }

    if (!grouped.has(match.applicationId)) {
      grouped.set(match.applicationId, []);
    }

    const applicationMatches = grouped.get(match.applicationId);
    const alreadyAdded = applicationMatches.some(
      (existing) => existing.projectId === match.projectId,
    );

    if (!alreadyAdded) {
      applicationMatches.push(match);
    }
  });

  return grouped;
}

function loadExistingPostHogProjectRows_(sheet) {
  const rowsByApplicationId = new Map();

  if (sheet.getLastRow() < 2) {
    return rowsByApplicationId;
  }

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, POSTHOG_PROJECT_HEADERS.length)
    .getValues();

  values.forEach((row) => {
    const applicationId = String(row[0] || '').trim();
    if (!applicationId) {
      return;
    }
    rowsByApplicationId.set(applicationId, {
      projectId: row[1],
      organization: row[2],
      projectUrl: row[3],
      sourceUpdatedAt: row[6],
      matchCount: Number(row[9]) || 0,
    });
  });

  return rowsByApplicationId;
}

function buildPostHogOutputRow_(
  applicationId,
  projectId,
  organization,
  projectUrl,
  attachmentText,
  googleGroupText,
  sourceUpdatedAt,
  syncedAt,
  status,
  matchCount,
  error,
) {
  return [
    applicationId,
    projectId,
    organization,
    projectUrl,
    attachmentText,
    googleGroupText,
    sourceUpdatedAt,
    syncedAt,
    status,
    matchCount,
    error,
  ].map((value) => safeCellValue_(value));
}

function sanitizePostHogAttachmentLabel_(value, fallbackIndex) {
  const cleaned = String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return truncatePostHogText_(cleaned || `Attachment ${fallbackIndex}`, 500);
}

function buildPostHogAttachmentText_(links) {
  return links.map((link) => link.filename).join('\n');
}

function buildPostHogGoogleGroupText_(links) {
  return links.map((link) => link.url).join('\n');
}

/**
 * Converts the attachment display text in column E into per-file rich-text
 * hyperlinks. Multiple files remain independently clickable within one cell.
 */
function applyPostHogAttachmentLinks_(
  sheet,
  applicationIds,
  linksByApplicationId,
) {
  if (applicationIds.length === 0) {
    return;
  }

  const richTextRows = applicationIds.map((applicationId) => {
    const links = linksByApplicationId.get(applicationId) || [];
    const text = buildPostHogAttachmentText_(links);
    const builder = SpreadsheetApp.newRichTextValue().setText(text);
    let startOffset = 0;

    links.forEach((link, index) => {
      const endOffset = startOffset + link.filename.length;
      builder.setLinkUrl(startOffset, endOffset, link.url);
      startOffset = endOffset + (index < links.length - 1 ? 1 : 0);
    });

    return [builder.build()];
  });

  sheet
    .getRange(2, 5, richTextRows.length, 1)
    .setRichTextValues(richTextRows)
    .setWrap(true);
}

/**
 * Converts the Google Groups display text in column F into per-URL rich-text
 * hyperlinks. Multiple exact conversations remain independently clickable.
 */
function applyPostHogGoogleGroupLinks_(
  sheet,
  applicationIds,
  linksByApplicationId,
) {
  if (applicationIds.length === 0) {
    return;
  }

  const richTextRows = applicationIds.map((applicationId) => {
    const links = linksByApplicationId.get(applicationId) || [];
    const text = buildPostHogGoogleGroupText_(links);
    const builder = SpreadsheetApp.newRichTextValue().setText(text);
    let startOffset = 0;

    links.forEach((link, index) => {
      const endOffset = startOffset + link.url.length;
      builder.setLinkUrl(startOffset, endOffset, link.url);
      startOffset = endOffset + (index < links.length - 1 ? 1 : 0);
    });

    return [builder.build()];
  });

  sheet
    .getRange(2, 6, richTextRows.length, 1)
    .setRichTextValues(richTextRows)
    .setWrap(true);
}

function rewritePostHogProjectRows_(sheet, rows) {
  const existingDataRows = Math.max(sheet.getLastRow() - 1, 0);

  if (rows.length > 0) {
    const requiredRows = rows.length + 1;
    if (sheet.getMaxRows() < requiredRows) {
      sheet.insertRowsAfter(
        sheet.getMaxRows(),
        requiredRows - sheet.getMaxRows(),
      );
    }
    sheet
      .getRange(2, 1, rows.length, POSTHOG_PROJECT_HEADERS.length)
      .setValues(rows);
  }

  if (existingDataRows > rows.length) {
    sheet
      .getRange(
        rows.length + 2,
        1,
        existingDataRows - rows.length,
        POSTHOG_PROJECT_HEADERS.length,
      )
      .clearContent();
  }
}

function isSafePostHogApplicationId_(applicationId) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(String(applicationId));
}

function postHogStringLiteral_(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function parsePostHogDate_(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date;
}

function chunkPostHogArray_(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncatePostHogText_(text, maxLength) {
  const value = String(text || '');
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

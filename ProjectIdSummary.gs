/**
 * GoodLeap TPO - Project ID operational summary
 *
 * This file belongs in the SAME Apps Script project as the other workflow
 * files. It maintains one row per resolved Project ID by combining the
 * authoritative URL in PostHog Projects with email, attachment, and PDF
 * counts from the archive sheets. It does not call Gmail, PostHog, OpenAI, or
 * Drive APIs.
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
};

const PROJECT_ID_SUMMARY_HEADERS = [
  'Project ID',
  'Project URL',
  'Email Count',
  'Attachment Count',
  'Analyzed PDF Count',
  'First Email Received At',
  'Last Email Received At',
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
 * Calculates the complete summary without writing the destination sheet.
 */
function previewProjectIdSummary() {
  const resources = getOrCreateResources_();
  const summary = buildProjectIdSummary_(resources.spreadsheet);
  const result = buildProjectIdSummaryStats_(summary);
  result.preview = summary.rows.slice(0, 10).map((row) => ({
    projectId: row[0],
    projectUrl: row[1],
    emailCount: row[2],
    attachmentCount: row[3],
    analyzedPdfCount: row[4],
    firstEmailReceivedAt: row[5] || '',
    lastEmailReceivedAt: row[6] || '',
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
function refreshProjectIdSummarySafely_(spreadsheet) {
  try {
    return refreshProjectIdSummaryForSpreadsheet_(spreadsheet);
  } catch (error) {
    const message = String(error).slice(0, 1000);
    console.error(`Project ID Summary refresh failed safely: ${message}`);
    return {updated: false, error: message};
  }
}

function refreshProjectIdSummaryForSpreadsheet_(spreadsheet) {
  const summary = buildProjectIdSummary_(spreadsheet);
  const sheet = getOrCreateProjectIdSummarySheet_(spreadsheet);
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

function buildProjectIdSummary_(spreadsheet) {
  const projects = loadProjectIdSummaryBaseProjects_(spreadsheet);
  const emailMetrics = loadProjectIdSummaryEmailMetrics_(spreadsheet);
  const pdfCounts = loadProjectIdSummaryProjectCounts_(
    spreadsheet,
    PROJECT_ID_SUMMARY_CONFIG.PDF_SHEET_NAME,
  );
  const attachmentCounts = loadProjectIdSummaryAttachmentCounts_(spreadsheet);
  const rows = [];
  let projectsWithoutEmails = 0;
  let projectsWithoutPdfs = 0;
  let projectsWithoutAttachments = 0;

  projects.forEach((project) => {
    const email = emailMetrics.get(project.key) || {
      count: 0,
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

    rows.push([
      project.projectId,
      project.projectUrl,
      email.count,
      attachmentCount,
      pdfCount,
      email.firstReceivedAt,
      email.lastReceivedAt,
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
    pdfRowsWithProjectId: Array.from(pdfCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    ),
  };
}

function buildProjectIdSummaryStats_(summary) {
  return {
    uniqueProjects: summary.rows.length,
    emailRowsWithProjectId: summary.emailRowsWithProjectId,
    pdfRowsWithProjectId: summary.pdfRowsWithProjectId,
    projectsWithoutEmails: summary.projectsWithoutEmails,
    projectsWithoutPdfs: summary.projectsWithoutPdfs,
    projectsWithoutAttachments: summary.projectsWithoutAttachments,
  };
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

  values.slice(1).forEach((row) => {
    const projectIds = splitProjectIdSummaryIds_(row[projectIdIndex]);
    const receivedAt = normalizeProjectIdSummaryDate_(row[receivedAtIndex]);
    projectIds.forEach((projectId) => {
      const key = projectId.toLowerCase();
      const metric = metrics.get(key) || {
        count: 0,
        firstReceivedAt: '',
        lastReceivedAt: '',
      };
      metric.count += 1;
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

  const currentHeaders = sheet.getLastRow() > 0
    ? sheet
        .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
        .getDisplayValues()[0]
        .map((value) => String(value).trim())
    : [];
  const hasUnexpectedContent = currentHeaders.some(Boolean) &&
    !PROJECT_ID_SUMMARY_HEADERS.every(
      (header, index) => currentHeaders[index] === header,
    );
  if (hasUnexpectedContent) {
    throw new Error(
      'Project ID Summary already exists with an unexpected schema. ' +
      'Rename or review that sheet before setup so no data is overwritten.',
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
  return sheet;
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

  const richUrls = rows.map((row) => {
    const url = String(row[1] || '').trim();
    const builder = SpreadsheetApp.newRichTextValue().setText(url);
    if (url) builder.setLinkUrl(url);
    return [builder.build()];
  });
  sheet.getRange(2, 2, rows.length, 1).setRichTextValues(richUrls);
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

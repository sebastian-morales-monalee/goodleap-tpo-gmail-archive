/**
 * GoodLeap TPO - Gmail -> Google Drive + Google Sheets
 *
 * Safe workflow:
 *   1) setupGoodLeapArchive()
 *   2) previewGoodLeapMatches()
 *   3) processGoodLeapHistory()
 *   4) installGoodLeapTrigger()
 *
 * The script does NOT delete, archive, or mark emails as read.
 * Labels are visual only. Actual deduplication uses the unique Gmail message
 * ID and the SHA-1 hash of each attachment.
 */

const CONFIG = {
  // Confirm that this is the address visible in the email's "To" field.
  GROUP_EMAIL: 'goodleap-tpo@artemispower.com',

  // Test this exact query in Gmail search first.
  GMAIL_QUERY: 'to:goodleap-tpo@artemispower.com has:attachment',

  TIMEZONE: 'America/Bogota',
  ROOT_FOLDER_NAME: 'GoodLeap TPO Archive',
  SPREADSHEET_NAME: 'GoodLeap TPO Email Archive',
  PROCESSED_LABEL: 'GoodLeap/Processed',
  ERROR_LABEL: 'GoodLeap/Error',

  // Start date for the historical import. Format: YYYY/MM/DD.
  BACKFILL_AFTER: '2026/08/01',

  // Conservative limits to avoid exceeding Apps Script execution time.
  PREVIEW_MAX_THREADS: 20,
  BACKFILL_MAX_THREADS: 500,
  RECENT_MAX_THREADS: 100,
  RECENT_DAYS: 30,

  // Sheets supports up to 50,000 characters per cell. The complete body is
  // also saved as a TXT file in Drive.
  BODY_CELL_MAX_CHARS: 45000,
  SAVE_BODY_TEXT_FILE: true,

  // Enable this only if the complete MIME message must be retained. An EML
  // duplicates some attachment content and consumes additional storage.
  SAVE_RAW_EML: false,
};

const PROPERTY_KEYS = {
  ROOT_FOLDER_ID: 'GOODLEAP_ROOT_FOLDER_ID',
  SPREADSHEET_ID: 'GOODLEAP_SPREADSHEET_ID',
  FORMAT_VERSION: 'GOODLEAP_FORMAT_VERSION',
};

const CURRENT_FORMAT_VERSION = '1';

const EMAIL_HEADERS = [
  'Processed At',
  'Received At',
  'Case ID',
  'Update Type',
  'From',
  'To',
  'Cc',
  'Subject',
  'Proposed Production kWh',
  'GoodLeap Benchmark kWh',
  'Tolerance %',
  'Email Body',
  'Body TXT URL',
  'Drive Folder URL',
  'Attachment Count',
  'Attachment URLs',
  'Gmail Message ID',
  'Gmail Thread ID',
  'Gmail URL',
  'Status',
  'Error',
];

const ATTACHMENT_HEADERS = [
  'Processed At',
  'Received At',
  'Case ID',
  'Gmail Message ID',
  'Attachment Index',
  'Attachment Hash',
  'Original Filename',
  'Saved Filename',
  'MIME Type',
  'Size Bytes',
  'Drive URL',
  'Drive File ID',
];

const ERROR_HEADERS = [
  'Occurred At',
  'Gmail Message ID',
  'Subject',
  'Error',
  'Stack',
];

// Both names are included so trigger installation can migrate safely from the
// original Gmail-only schedule to the integrated Gmail + PostHog schedule.
const GOODLEAP_FIVE_MINUTE_TRIGGER_HANDLERS = [
  'processRecentGoodLeapEmails',
  'processRecentGoodLeapEmailsAndSyncPostHog',
];

/**
 * Creates a folder in My Drive, a spreadsheet, and the Gmail labels.
 * It is idempotent: subsequent runs reuse the same resources.
 */
function setupGoodLeapArchive() {
  const resources = getOrCreateResources_();

  getOrCreateGmailLabel_(CONFIG.PROCESSED_LABEL);
  getOrCreateGmailLabel_(CONFIG.ERROR_LABEL);

  console.log('Setup completed.');
  console.log(`Drive folder: ${resources.rootFolder.getUrl()}`);
  console.log(`Google Sheet: ${resources.spreadsheet.getUrl()}`);
  console.log(`Gmail query: ${CONFIG.GMAIL_QUERY}`);

  return {
    driveFolderUrl: resources.rootFolder.getUrl(),
    spreadsheetUrl: resources.spreadsheet.getUrl(),
    gmailQuery: CONFIG.GMAIL_QUERY,
  };
}

/**
 * Preview only. It does not create files, write rows, or apply labels.
 */
function previewGoodLeapMatches() {
  const threads = GmailApp.search(
    CONFIG.GMAIL_QUERY,
    0,
    CONFIG.PREVIEW_MAX_THREADS,
  );

  let messageCount = 0;
  let attachmentCount = 0;

  console.log(`Query: ${CONFIG.GMAIL_QUERY}`);
  console.log(`Matching threads scanned: ${threads.length}`);

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const attachments = getRealAttachments_(message);
      if (!messageBelongsToGroup_(message) || attachments.length === 0) {
        return;
      }

      messageCount += 1;
      attachmentCount += attachments.length;
      console.log(
        `[MATCH] ${formatDate_(message.getDate(), 'yyyy-MM-dd HH:mm:ss')} | ` +
        `${message.getFrom()} | ${message.getSubject()} | ` +
        `${attachments.length} attachment(s)`,
      );
    });
  });

  console.log(`Matching messages: ${messageCount}`);
  console.log(`Matching attachments: ${attachmentCount}`);

  if (messageCount === 0) {
    console.log(
      'No messages matched. Test CONFIG.GMAIL_QUERY directly in Gmail and ' +
      'adjust it before processing.',
    );
  }

  return {threads: threads.length, messages: messageCount, attachments: attachmentCount};
}

/**
 * Imports historical emails from CONFIG.BACKFILL_AFTER.
 * It can run repeatedly without duplicating registered messages or attachments.
 */
function processGoodLeapHistory() {
  const query = `${CONFIG.GMAIL_QUERY} after:${CONFIG.BACKFILL_AFTER}`;
  return processQuery_(query, CONFIG.BACKFILL_MAX_THREADS, 'history');
}

/**
 * Processes only the recent Gmail search window.
 */
function processRecentGoodLeapEmails() {
  const query = `${CONFIG.GMAIL_QUERY} newer_than:${CONFIG.RECENT_DAYS}d`;
  return processQuery_(query, CONFIG.RECENT_MAX_THREADS, 'recent');
}

/**
 * Installs the Gmail-only five-minute trigger. This remains useful before
 * PostHog is configured, and it also restores Gmail-only operation if needed.
 */
function installGoodLeapTrigger() {
  setupGoodLeapArchive();

  const removed = removeGoodLeapFiveMinuteTriggers_();

  ScriptApp.newTrigger('processRecentGoodLeapEmails')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log(`Replaced five-minute triggers: ${removed}.`);
  console.log('Gmail-only trigger installed: processRecentGoodLeapEmails every 5 minutes.');
}

/**
 * Removes either version of the five-minute Gmail trigger. It does not remove
 * the independent hourly PostHog fallback trigger.
 */
function removeGoodLeapTrigger() {
  const removed = removeGoodLeapFiveMinuteTriggers_();
  console.log(`Triggers removed: ${removed}`);
}

function removeGoodLeapFiveMinuteTriggers_() {
  let removed = 0;

  ScriptApp.getProjectTriggers()
    .filter((trigger) =>
      GOODLEAP_FIVE_MINUTE_TRIGGER_HANDLERS.includes(
        trigger.getHandlerFunction(),
      ),
    )
    .forEach((trigger) => {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    });

  return removed;
}

function processQuery_(query, maxThreads, mode) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('Another execution is already running. This run was skipped safely.');
    return {skippedBecauseLocked: true};
  }

  try {
    const resources = getOrCreateResources_();
    const emailsSheet = resources.spreadsheet.getSheetByName('Emails');
    const attachmentsSheet = resources.spreadsheet.getSheetByName('Attachments');
    const errorsSheet = resources.spreadsheet.getSheetByName('Errors');
    const processedMessageIds = loadProcessedMessageIds_(emailsSheet);
    const attachmentUrlByKey = loadAttachmentUrlMap_(attachmentsSheet);
    const processedLabel = getOrCreateGmailLabel_(CONFIG.PROCESSED_LABEL);
    const errorLabel = getOrCreateGmailLabel_(CONFIG.ERROR_LABEL);
    const threads = GmailApp.search(query, 0, maxThreads);

    const stats = {
      mode,
      query,
      threadsScanned: threads.length,
      messagesProcessed: 0,
      messagesSkipped: 0,
      attachmentsSaved: 0,
      errors: 0,
    };

    threads.forEach((thread) => {
      thread.getMessages().forEach((message) => {
        const attachments = getRealAttachments_(message);
        if (!messageBelongsToGroup_(message) || attachments.length === 0) {
          return;
        }

        const messageId = message.getId();
        if (processedMessageIds.has(messageId)) {
          stats.messagesSkipped += 1;
          return;
        }

        try {
          const result = processMessage_(
            message,
            attachments,
            resources,
            emailsSheet,
            attachmentsSheet,
            attachmentUrlByKey,
          );
          processedMessageIds.add(messageId);
          stats.messagesProcessed += 1;
          stats.attachmentsSaved += result.attachmentsSaved;
          thread.addLabel(processedLabel);
        } catch (error) {
          stats.errors += 1;
          appendSafeRow_(errorsSheet, [
            new Date(),
            messageId,
            message.getSubject(),
            String(error),
            error && error.stack ? String(error.stack) : '',
          ]);
          thread.addLabel(errorLabel);
          console.error(`[ERROR] ${message.getSubject()} | ${error}`);
        }
      });
    });

    SpreadsheetApp.flush();
    console.log(JSON.stringify(stats, null, 2));
    console.log(`Drive folder: ${resources.rootFolder.getUrl()}`);
    console.log(`Google Sheet: ${resources.spreadsheet.getUrl()}`);
    return stats;
  } finally {
    lock.releaseLock();
  }
}

function processMessage_(
  message,
  attachments,
  resources,
  emailsSheet,
  attachmentsSheet,
  attachmentUrlByKey,
) {
  const processedAt = new Date();
  const receivedAt = message.getDate();
  const messageId = message.getId();
  const threadId = message.getThread().getId();
  const subject = message.getSubject() || '';
  const body = message.getPlainBody() || '';
  const extracted = extractGoodLeapFields_(subject, body);
  const caseFolder = getCaseFolder_(resources.rootFolder, receivedAt, extracted.caseId);
  const timestamp = formatDate_(receivedAt, 'yyyyMMdd_HHmmss');
  const shortMessageId = messageId.slice(-10);

  let bodyTextUrl = '';
  if (CONFIG.SAVE_BODY_TEXT_FILE) {
    const bodyFileName = sanitizeFileName_(
      `${extracted.caseId}_${timestamp}_${shortMessageId}_email.txt`,
    );
    const bodyFileContent = [
      `Received At: ${formatDate_(receivedAt, 'yyyy-MM-dd HH:mm:ss')}`,
      `From: ${message.getFrom()}`,
      `To: ${message.getTo()}`,
      `Cc: ${message.getCc()}`,
      `Subject: ${subject}`,
      `Gmail Message ID: ${messageId}`,
      '',
      body,
    ].join('\n');
    const bodyFile = createOrGetTextFile_(caseFolder, bodyFileName, bodyFileContent);
    bodyTextUrl = bodyFile.getUrl();
  }

  if (CONFIG.SAVE_RAW_EML) {
    const emlFileName = sanitizeFileName_(
      `${extracted.caseId}_${timestamp}_${shortMessageId}_email.eml`,
    );
    createOrGetBlobFile_(
      caseFolder,
      emlFileName,
      Utilities.newBlob(message.getRawContent(), 'message/rfc822', emlFileName),
    );
  }

  const attachmentUrls = [];
  let attachmentsSaved = 0;

  attachments.forEach((attachment, index) => {
    const originalName = attachment.getName() || `attachment-${index + 1}`;
    const hash = attachment.getHash();
    const attachmentIndex = index + 1;
    const attachmentKey = `${messageId}|${attachmentIndex}|${hash}`;

    if (attachmentUrlByKey.has(attachmentKey)) {
      attachmentUrls.push(attachmentUrlByKey.get(attachmentKey));
      return;
    }

    const savedName = sanitizeFileName_(
      `${extracted.caseId}_${timestamp}_${shortMessageId}_${originalName}`,
    );
    const file = createOrGetBlobFile_(caseFolder, savedName, attachment);

    appendSafeRow_(attachmentsSheet, [
      processedAt,
      receivedAt,
      extracted.caseId,
      messageId,
      attachmentIndex,
      hash,
      originalName,
      savedName,
      attachment.getContentType() || '',
      attachment.getSize(),
      file.getUrl(),
      file.getId(),
    ]);

    attachmentUrlByKey.set(attachmentKey, file.getUrl());
    attachmentUrls.push(file.getUrl());
    attachmentsSaved += 1;
  });

  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${messageId}`;

  appendSafeRow_(emailsSheet, [
    processedAt,
    receivedAt,
    extracted.caseId,
    extracted.updateType,
    message.getFrom(),
    message.getTo(),
    message.getCc(),
    subject,
    extracted.proposedProductionKwh,
    extracted.goodLeapBenchmarkKwh,
    extracted.tolerancePercent,
    truncateForCell_(body),
    bodyTextUrl,
    caseFolder.getUrl(),
    attachments.length,
    attachmentUrls.join('\n'),
    messageId,
    threadId,
    gmailUrl,
    'Processed',
    '',
  ]);

  return {attachmentsSaved};
}

function getOrCreateResources_() {
  const properties = PropertiesService.getScriptProperties();
  let rootFolder = null;
  let spreadsheet = null;

  const storedFolderId = properties.getProperty(PROPERTY_KEYS.ROOT_FOLDER_ID);
  if (storedFolderId) {
    try {
      rootFolder = DriveApp.getFolderById(storedFolderId);
    } catch (error) {
      properties.deleteProperty(PROPERTY_KEYS.ROOT_FOLDER_ID);
    }
  }

  if (!rootFolder) {
    rootFolder = DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
    properties.setProperty(PROPERTY_KEYS.ROOT_FOLDER_ID, rootFolder.getId());
  }

  const storedSpreadsheetId = properties.getProperty(PROPERTY_KEYS.SPREADSHEET_ID);
  if (storedSpreadsheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(storedSpreadsheetId);
    } catch (error) {
      properties.deleteProperty(PROPERTY_KEYS.SPREADSHEET_ID);
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    spreadsheet.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
    spreadsheet.getSheets()[0].setName('Emails');
    DriveApp.getFileById(spreadsheet.getId()).moveTo(rootFolder);
    properties.setProperty(PROPERTY_KEYS.SPREADSHEET_ID, spreadsheet.getId());
    properties.deleteProperty(PROPERTY_KEYS.FORMAT_VERSION);
  }

  const emailsSheet = getOrCreateSheet_(spreadsheet, 'Emails', EMAIL_HEADERS);
  const attachmentsSheet = getOrCreateSheet_(
    spreadsheet,
    'Attachments',
    ATTACHMENT_HEADERS,
  );
  getOrCreateSheet_(spreadsheet, 'Errors', ERROR_HEADERS);

  const expectedFormatMarker = `${spreadsheet.getId()}:${CURRENT_FORMAT_VERSION}`;
  if (properties.getProperty(PROPERTY_KEYS.FORMAT_VERSION) !== expectedFormatMarker) {
    formatArchiveSheets_(emailsSheet, attachmentsSheet);
    properties.setProperty(PROPERTY_KEYS.FORMAT_VERSION, expectedFormatMarker);
  }

  return {rootFolder, spreadsheet};
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet
      .getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#6e04bd')
      .setFontColor('#ffffff');
  } else {
    const existingHeaders = sheet
      .getRange(1, 1, 1, headers.length)
      .getDisplayValues()[0];
    const headersMatch = headers.every((header, index) => existingHeaders[index] === header);
    if (!headersMatch) {
      throw new Error(
        `The headers in sheet "${name}" do not match the expected structure. ` +
        'Do not reorder or rename columns used by the script.',
      );
    }
  }

  return sheet;
}

function formatArchiveSheets_(emailsSheet, attachmentsSheet) {
  emailsSheet.getRange('A:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  emailsSheet.getRange('I:K').setNumberFormat('0.###');
  emailsSheet.setColumnWidth(3, 120);
  emailsSheet.setColumnWidth(8, 420);
  emailsSheet.setColumnWidth(12, 500);
  emailsSheet.setColumnWidth(16, 300);

  attachmentsSheet.getRange('A:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  attachmentsSheet.setColumnWidth(6, 260);
  attachmentsSheet.setColumnWidth(7, 280);
  attachmentsSheet.setColumnWidth(8, 360);
  attachmentsSheet.setColumnWidth(11, 300);
}

function getCaseFolder_(rootFolder, receivedAt, caseId) {
  const yearFolder = getOrCreateChildFolder_(
    rootFolder,
    formatDate_(receivedAt, 'yyyy'),
  );
  const monthFolder = getOrCreateChildFolder_(
    yearFolder,
    formatDate_(receivedAt, 'MM'),
  );
  return getOrCreateChildFolder_(monthFolder, caseId || 'NO_CASE_ID');
}

function getOrCreateChildFolder_(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function createOrGetTextFile_(folder, name, content) {
  const existingFiles = folder.getFilesByName(name);
  if (existingFiles.hasNext()) {
    return existingFiles.next();
  }
  return folder.createFile(name, content, MimeType.PLAIN_TEXT);
}

function createOrGetBlobFile_(folder, name, blob) {
  const existingFiles = folder.getFilesByName(name);
  if (existingFiles.hasNext()) {
    return existingFiles.next();
  }
  return folder.createFile(blob).setName(name);
}

function getRealAttachments_(message) {
  return message.getAttachments({
    includeInlineImages: false,
    includeAttachments: true,
  });
}

function messageBelongsToGroup_(message) {
  const groupEmail = CONFIG.GROUP_EMAIL.toLowerCase();
  const groupLocalPart = groupEmail.split('@')[0];
  const headers = [
    message.getTo(),
    message.getCc(),
    message.getHeader('List-Id'),
    message.getHeader('X-Original-To'),
  ]
    .join(' ')
    .toLowerCase();

  return headers.includes(groupEmail) || headers.includes(groupLocalPart);
}

function extractGoodLeapFields_(subject, body) {
  const combined = `${subject}\n${body}`;
  const caseMatch = combined.match(/\b\d{2}-\d{2}-\d{6}\b/);
  let updateType = 'Other';

  if (/pre[\s-]?check/i.test(subject)) {
    updateType = 'Pre-Check';
  } else if (/validation/i.test(subject)) {
    updateType = 'Validation';
  }

  return {
    caseId: caseMatch ? caseMatch[0] : 'NO_CASE_ID',
    updateType,
    proposedProductionKwh: extractNumber_(
      body,
      /Proposed\s+Production\s*:\s*([+-]?[\d,.]+)/i,
    ),
    goodLeapBenchmarkKwh: extractNumber_(
      body,
      /GoodLeap\s+Benchmark\s+Production\s*:\s*([+-]?[\d,.]+)/i,
    ),
    tolerancePercent: extractNumber_(
      body,
      /Tolerance\s*:\s*([+-]?[\d,.]+)/i,
    ),
  };
}

function extractNumber_(text, regex) {
  const match = text.match(regex);
  if (!match) {
    return '';
  }
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : '';
}

function loadProcessedMessageIds_(sheet) {
  const ids = new Set();
  if (sheet.getLastRow() < 2) {
    return ids;
  }

  const values = sheet
    .getRange(2, 17, sheet.getLastRow() - 1, 1)
    .getDisplayValues();
  values.forEach((row) => {
    if (row[0]) {
      ids.add(row[0]);
    }
  });
  return ids;
}

function loadAttachmentUrlMap_(sheet) {
  const urlByKey = new Map();
  if (sheet.getLastRow() < 2) {
    return urlByKey;
  }

  const values = sheet
    .getRange(2, 4, sheet.getLastRow() - 1, 8)
    .getDisplayValues();
  values.forEach((row) => {
    const messageId = row[0];
    const attachmentIndex = row[1];
    const hash = row[2];
    const driveUrl = row[7];
    if (messageId && attachmentIndex && hash) {
      urlByKey.set(`${messageId}|${attachmentIndex}|${hash}`, driveUrl);
    }
  });
  return urlByKey;
}

function getOrCreateGmailLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function appendSafeRow_(sheet, values) {
  const safeValues = values.map((value) => safeCellValue_(value));
  const expectedColumns = sheet.getLastColumn();
  if (safeValues.length !== expectedColumns) {
    throw new Error(
      `Row width mismatch in sheet "${sheet.getName()}": ` +
      `expected ${expectedColumns}, received ${safeValues.length}.`,
    );
  }
  sheet
    .getRange(sheet.getLastRow() + 1, 1, 1, safeValues.length)
    .setValues([safeValues]);
}

function safeCellValue_(value) {
  if (typeof value !== 'string') {
    return value;
  }
  // Prevents external content from being interpreted as a formula in Sheets.
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function truncateForCell_(text) {
  const limit = CONFIG.BODY_CELL_MAX_CHARS;
  if (text.length <= limit) {
    return text;
  }
  const notice = '\n\n[TRUNCATED IN SHEET - SEE BODY TXT FILE IN DRIVE]';
  return text.slice(0, limit - notice.length) + notice;
}

function sanitizeFileName_(name) {
  const sanitized = String(name)
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || 'unnamed-file').slice(0, 180);
}

function formatDate_(date, pattern) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, pattern);
}

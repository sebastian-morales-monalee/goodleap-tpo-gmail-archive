/**
 * GoodLeap TPO - manual patch for four forwarded historical emails.
 *
 * Add this file to the SAME Apps Script project that contains Code.gs.
 * It does not install triggers or modify the existing automated query.
 *
 * Workflow:
 *   1) setupGoodLeapManualBackfill()
 *   2) Apply the GoodLeap/ManualBackfill Gmail label to the four forwarded emails.
 *   3) previewGoodLeapManualBackfill()
 *   4) processGoodLeapManualBackfill()
 *
 * Requires the existing helper functions in Code.gs.
 */

const MANUAL_BACKFILL_CONFIG = {
  LABEL: 'GoodLeap/ManualBackfill',
  ORIGINAL_SENDER_EMAIL: 'designteam@goodleap.com',
  MAX_THREADS: 20,
  CASE_IDS: [
    '26-42-004485',
    '26-30-001387',
    '26-44-005345',
    '26-44-005256',
  ],
};

function setupGoodLeapManualBackfill() {
  const label = getOrCreateGmailLabel_(MANUAL_BACKFILL_CONFIG.LABEL);
  console.log(`Manual backfill label ready: ${label.getName()}`);
  console.log('Apply this label only to the four forwarded GoodLeap emails.');
  console.log(`Expected Case IDs: ${MANUAL_BACKFILL_CONFIG.CASE_IDS.join(', ')}`);
}

function previewGoodLeapManualBackfill() {
  const scan = scanManualBackfillCandidates_();

  scan.candidates.forEach((candidate) => {
    if (!candidate.valid) {
      console.log(
        `[REJECTED] ${candidate.message.getSubject()} | ${candidate.reason}`,
      );
      return;
    }

    console.log(
      `[READY] ${candidate.caseId} | ` +
      `${formatDate_(candidate.metadata.receivedAt, 'yyyy-MM-dd HH:mm:ss')} | ` +
      `${candidate.metadata.from} | ` +
      `${candidate.attachments.length} attachment(s)`,
    );
  });

  console.log(JSON.stringify({
    mode: 'manual-backfill-preview',
    labeledThreads: scan.threads.length,
    validMessages: scan.validCandidates.length,
    rejectedMessages: scan.rejectedCandidates.length,
    validAttachments: scan.validCandidates.reduce(
      (total, candidate) => total + candidate.attachments.length,
      0,
    ),
    foundCaseIds: scan.foundCaseIds,
    missingCaseIds: scan.missingCaseIds,
    duplicateCaseIds: scan.duplicateCaseIds,
  }, null, 2));

  if (scan.missingCaseIds.length > 0) {
    console.log(
      `STOP: missing expected Case IDs: ${scan.missingCaseIds.join(', ')}`,
    );
  }

  if (scan.duplicateCaseIds.length > 0) {
    console.log(
      `STOP: more than one valid forwarded message was found for: ` +
      `${scan.duplicateCaseIds.join(', ')}`,
    );
  }

  return {
    validMessages: scan.validCandidates.length,
    rejectedMessages: scan.rejectedCandidates.length,
    missingCaseIds: scan.missingCaseIds,
    duplicateCaseIds: scan.duplicateCaseIds,
  };
}

function processGoodLeapManualBackfill() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) {
    console.log(
      'Another execution is already running. This run was skipped safely.',
    );
    return {skippedBecauseLocked: true};
  }

  try {
    const scan = scanManualBackfillCandidates_();
    assertManualBackfillReady_(scan);

    const resources = getOrCreateResources_();
    const emailsSheet = resources.spreadsheet.getSheetByName('Emails');
    const attachmentsSheet =
      resources.spreadsheet.getSheetByName('Attachments');
    const errorsSheet = resources.spreadsheet.getSheetByName('Errors');

    const processedMessageIds = loadProcessedMessageIds_(emailsSheet);
    const caseHashUrlMap = loadManualCaseHashUrlMap_(attachmentsSheet);
    const processedLabel =
      getOrCreateGmailLabel_(CONFIG.PROCESSED_LABEL);
    const errorLabel =
      getOrCreateGmailLabel_(CONFIG.ERROR_LABEL);

    const stats = {
      mode: 'manual-backfill',
      labeledThreads: scan.threads.length,
      messagesProcessed: 0,
      messagesSkipped: 0,
      attachmentsSaved: 0,
      attachmentsReused: 0,
      errors: 0,
    };

    scan.validCandidates.forEach((candidate) => {
      const message = candidate.message;
      const messageId = message.getId();

      if (processedMessageIds.has(messageId)) {
        stats.messagesSkipped += 1;
        console.log(
          `[SKIPPED] ${candidate.caseId} | Gmail message already processed.`,
        );
        return;
      }

      try {
        const result = processManualForwardedMessage_(
          candidate,
          resources,
          emailsSheet,
          attachmentsSheet,
          caseHashUrlMap,
        );

        processedMessageIds.add(messageId);
        stats.messagesProcessed += 1;
        stats.attachmentsSaved += result.attachmentsSaved;
        stats.attachmentsReused += result.attachmentsReused;
        message.getThread().addLabel(processedLabel);
      } catch (error) {
        stats.errors += 1;

        appendSafeRow_(errorsSheet, [
          new Date(),
          messageId,
          message.getSubject(),
          String(error),
          error && error.stack ? String(error.stack) : '',
        ]);

        message.getThread().addLabel(errorLabel);
        console.error(`[ERROR] ${candidate.caseId} | ${error}`);
      }
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

function scanManualBackfillCandidates_() {
  const label =
    getOrCreateGmailLabel_(MANUAL_BACKFILL_CONFIG.LABEL);

  const threads =
    label.getThreads(0, MANUAL_BACKFILL_CONFIG.MAX_THREADS);

  const candidates = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      candidates.push(buildManualBackfillCandidate_(message));
    });
  });

  const validCandidates =
    candidates.filter((candidate) => candidate.valid);

  const rejectedCandidates =
    candidates.filter((candidate) => !candidate.valid);

  const countsByCaseId = new Map();

  validCandidates.forEach((candidate) => {
    countsByCaseId.set(
      candidate.caseId,
      (countsByCaseId.get(candidate.caseId) || 0) + 1,
    );
  });

  const foundCaseIds =
    MANUAL_BACKFILL_CONFIG.CASE_IDS.filter(
      (caseId) => countsByCaseId.has(caseId),
    );

  const missingCaseIds =
    MANUAL_BACKFILL_CONFIG.CASE_IDS.filter(
      (caseId) => !countsByCaseId.has(caseId),
    );

  const duplicateCaseIds =
    MANUAL_BACKFILL_CONFIG.CASE_IDS.filter(
      (caseId) => (countsByCaseId.get(caseId) || 0) > 1,
    );

  return {
    threads,
    candidates,
    validCandidates,
    rejectedCandidates,
    foundCaseIds,
    missingCaseIds,
    duplicateCaseIds,
  };
}

function buildManualBackfillCandidate_(message) {
  const subject = message.getSubject() || '';
  const body = message.getPlainBody() || '';
  const attachments = getRealAttachments_(message);
  const fields = extractGoodLeapFields_(subject, body);
  const caseId = fields.caseId;

  if (!MANUAL_BACKFILL_CONFIG.CASE_IDS.includes(caseId)) {
    return invalidManualCandidate_(
      message,
      attachments,
      caseId,
      `Case ID is not in the approved manual list: ${caseId}`,
    );
  }

  if (attachments.length === 0) {
    return invalidManualCandidate_(
      message,
      attachments,
      caseId,
      'No real attachment was found.',
    );
  }

  const metadataResult = extractForwardedMetadata_(message);

  if (!metadataResult.valid) {
    return invalidManualCandidate_(
      message,
      attachments,
      caseId,
      metadataResult.reason,
    );
  }

  const sender = metadataResult.metadata.from.toLowerCase();

  if (
    !sender.includes(
      MANUAL_BACKFILL_CONFIG.ORIGINAL_SENDER_EMAIL,
    )
  ) {
    return invalidManualCandidate_(
      message,
      attachments,
      caseId,
      `Original sender is not ${
        MANUAL_BACKFILL_CONFIG.ORIGINAL_SENDER_EMAIL
      }.`,
    );
  }

  if (!metadataResult.metadata.subject.includes(caseId)) {
    return invalidManualCandidate_(
      message,
      attachments,
      caseId,
      'Case ID does not appear in the original forwarded subject.',
    );
  }

  return {
    valid: true,
    reason: '',
    message,
    attachments,
    caseId,
    fields: extractGoodLeapFields_(
      metadataResult.metadata.subject,
      metadataResult.metadata.body,
    ),
    metadata: metadataResult.metadata,
  };
}

function invalidManualCandidate_(
  message,
  attachments,
  caseId,
  reason,
) {
  return {
    valid: false,
    reason,
    message,
    attachments,
    caseId,
    fields: null,
    metadata: null,
  };
}

function assertManualBackfillReady_(scan) {
  if (scan.missingCaseIds.length > 0) {
    throw new Error(
      `Manual backfill stopped. Missing Case IDs: ` +
      `${scan.missingCaseIds.join(', ')}. ` +
      'Run previewGoodLeapManualBackfill() and correct the Gmail labels first.',
    );
  }

  if (scan.duplicateCaseIds.length > 0) {
    throw new Error(
      `Manual backfill stopped. Duplicate Case IDs: ` +
      `${scan.duplicateCaseIds.join(', ')}. ` +
      'Keep exactly one forwarded email per Case ID.',
    );
  }

  if (
    scan.validCandidates.length !==
    MANUAL_BACKFILL_CONFIG.CASE_IDS.length
  ) {
    throw new Error(
      `Manual backfill stopped. Expected ` +
      `${MANUAL_BACKFILL_CONFIG.CASE_IDS.length} valid messages, ` +
      `found ${scan.validCandidates.length}.`,
    );
  }
}

function extractForwardedMetadata_(message) {
  const body = message.getPlainBody() || '';

  const markerMatch =
    body.match(/-{2,}\s*Forwarded message\s*-{2,}/i);

  if (!markerMatch || markerMatch.index === undefined) {
    return {
      valid: false,
      reason:
        'The forwarded-message marker was not found in the plain-text body.',
    };
  }

  const forwardedSection =
    body.slice(markerMatch.index + markerMatch[0].length);

  const originalFrom =
    extractForwardedHeader_(forwardedSection, 'From');

  const originalDateText =
    extractForwardedHeader_(forwardedSection, 'Date');

  const originalSubject =
    extractForwardedHeader_(forwardedSection, 'Subject');

  const originalTo =
    extractForwardedHeader_(forwardedSection, 'To');

  const originalCc =
    extractForwardedHeader_(forwardedSection, 'Cc');

  const originalDate =
    parseEnglishForwardedDate_(originalDateText);

  if (!originalFrom) {
    return {
      valid: false,
      reason: 'Original From header was not found.',
    };
  }

  if (!originalSubject) {
    return {
      valid: false,
      reason: 'Original Subject header was not found.',
    };
  }

  if (!originalDateText || !originalDate) {
    return {
      valid: false,
      reason:
        `Original Date could not be parsed: ` +
        `${originalDateText || '(missing)'}`,
    };
  }

  return {
    valid: true,
    metadata: {
      receivedAt: originalDate,
      from: originalFrom,
      to: originalTo || CONFIG.GROUP_EMAIL,
      cc: originalCc,
      subject: originalSubject,
      body,
    },
  };
}

function extractForwardedHeader_(
  forwardedSection,
  headerName,
) {
  const escapedHeaderName =
    headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const regex =
    new RegExp(`^${escapedHeaderName}:\\s*(.+)$`, 'im');

  const match = forwardedSection.match(regex);

  return match ? match[1].trim() : '';
}

function parseEnglishForwardedDate_(dateText) {
  if (!dateText) {
    return null;
  }

  const normalized =
    String(dateText).replace(/\u202f/g, ' ').trim();

  const match = normalized.match(
    /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)/i,
  );

  if (!match) {
    return null;
  }

  const months = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };

  const month = months[match[1].toLowerCase()];

  if (month === undefined) {
    return null;
  }

  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const meridiem = match[7].toUpperCase();

  if (hour === 12) {
    hour = 0;
  }

  if (meridiem === 'PM') {
    hour += 12;
  }

  // Bogota remains on UTC-05:00 throughout the year.
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      hour + 5,
      minute,
      second,
    ),
  );
}

function processManualForwardedMessage_(
  candidate,
  resources,
  emailsSheet,
  attachmentsSheet,
  caseHashUrlMap,
) {
  const processedAt = new Date();
  const message = candidate.message;
  const metadata = candidate.metadata;
  const receivedAt = metadata.receivedAt;
  const messageId = message.getId();
  const threadId = message.getThread().getId();
  const caseId = candidate.caseId;
  const extracted = candidate.fields;

  const caseFolder =
    getCaseFolder_(
      resources.rootFolder,
      receivedAt,
      caseId,
    );

  const timestamp =
    formatDate_(receivedAt, 'yyyyMMdd_HHmmss');

  const shortMessageId = messageId.slice(-10);

  let bodyTextUrl = '';

  if (CONFIG.SAVE_BODY_TEXT_FILE) {
    const bodyFileName =
      sanitizeFileName_(
        `${caseId}_${timestamp}_${shortMessageId}_email.txt`,
      );

    const bodyFileContent = [
      'Archive Mode: Manual Backfill from forwarded Gmail message',
      `Original Received At: ${
        formatDate_(receivedAt, 'yyyy-MM-dd HH:mm:ss')
      }`,
      `Original From: ${metadata.from}`,
      `Original To: ${metadata.to}`,
      `Original Cc: ${metadata.cc}`,
      `Original Subject: ${metadata.subject}`,
      `Forwarded Gmail Message ID: ${messageId}`,
      `Forwarded By: ${message.getFrom()}`,
      '',
      metadata.body,
    ].join('\n');

    const bodyFile =
      createOrGetTextFile_(
        caseFolder,
        bodyFileName,
        bodyFileContent,
      );

    bodyTextUrl = bodyFile.getUrl();
  }

  if (CONFIG.SAVE_RAW_EML) {
    const emlFileName =
      sanitizeFileName_(
        `${caseId}_${timestamp}_${shortMessageId}_email.eml`,
      );

    createOrGetBlobFile_(
      caseFolder,
      emlFileName,
      Utilities.newBlob(
        message.getRawContent(),
        'message/rfc822',
        emlFileName,
      ),
    );
  }

  const attachmentUrls = [];
  let attachmentsSaved = 0;
  let attachmentsReused = 0;

  candidate.attachments.forEach((attachment, index) => {
    const originalName =
      attachment.getName() || `attachment-${index + 1}`;

    const hash = attachment.getHash();
    const attachmentIndex = index + 1;
    const caseHashKey = `${caseId}|${hash}`;

    if (caseHashUrlMap.has(caseHashKey)) {
      attachmentUrls.push(caseHashUrlMap.get(caseHashKey));
      attachmentsReused += 1;
      return;
    }

    const savedName =
      sanitizeFileName_(
        `${caseId}_${timestamp}_${shortMessageId}_${originalName}`,
      );

    const file =
      createOrGetBlobFile_(
        caseFolder,
        savedName,
        attachment,
      );

    appendSafeRow_(attachmentsSheet, [
      processedAt,
      receivedAt,
      caseId,
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

    caseHashUrlMap.set(caseHashKey, file.getUrl());
    attachmentUrls.push(file.getUrl());
    attachmentsSaved += 1;
  });

  const gmailUrl =
    `https://mail.google.com/mail/u/0/#all/${messageId}`;

  appendSafeRow_(emailsSheet, [
    processedAt,
    receivedAt,
    caseId,
    extracted.updateType,
    metadata.from,
    metadata.to,
    metadata.cc,
    metadata.subject,
    extracted.proposedProductionKwh,
    extracted.goodLeapBenchmarkKwh,
    extracted.tolerancePercent,
    truncateForCell_(metadata.body),
    bodyTextUrl,
    caseFolder.getUrl(),
    candidate.attachments.length,
    attachmentUrls.join('\n'),
    messageId,
    threadId,
    gmailUrl,
    'Processed - Manual Backfill',
    '',
  ]);

  console.log(
    `[PROCESSED] ${caseId} | ` +
    `${attachmentsSaved} saved | ` +
    `${attachmentsReused} reused`,
  );

  return {
    attachmentsSaved,
    attachmentsReused,
  };
}

function loadManualCaseHashUrlMap_(attachmentsSheet) {
  const urlByCaseHash = new Map();

  if (attachmentsSheet.getLastRow() < 2) {
    return urlByCaseHash;
  }

  const rows =
    attachmentsSheet
      .getRange(
        2,
        3,
        attachmentsSheet.getLastRow() - 1,
        9,
      )
      .getDisplayValues();

  rows.forEach((row) => {
    const caseId = row[0];
    const hash = row[3];
    const driveUrl = row[8];

    if (caseId && hash && driveUrl) {
      urlByCaseHash.set(
        `${caseId}|${hash}`,
        driveUrl,
      );
    }
  });

  return urlByCaseHash;
}

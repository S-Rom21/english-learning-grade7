/**
 * English Training – report ingestion + Gmail PDF extraction bridge
 *
 * Receives structured JSON reports from the protected Cloudflare Pages Function,
 * stores them in a private Google Drive folder, and joins them to the PDF text
 * extracted from the original Gmail message.
 *
 * Required Apps Script advanced service: Drive API v3 (symbol: Drive).
 */

const PDF_BRIDGE_CONFIG = Object.freeze({
  recipient: 'schlegel21gpt@gmail.com',
  maxPdfBytes: 2 * 1024 * 1024,
  maxThreadsPerRun: 50,
  searchQuery: 'in:anywhere to:schlegel21gpt@gmail.com has:attachment filename:pdf newer_than:30d -subject:PDF-EXTRACTED',
  readyLabel: 'PDF-Text bereit',
  errorLabel: 'PDF-Text Fehler',
  triggerFunction: 'processEnglishTrainingPdfs'
});

const REPORT_INGEST_CONFIG = Object.freeze({
  tokenProperty: 'ENGLISH_TRAINING_REPORT_TOKEN',
  folderIdProperty: 'ENGLISH_TRAINING_REPORT_FOLDER_ID',
  filePropertyPrefix: 'ENGLISH_TRAINING_REPORT_FILE_',
  folderName: 'English Training Reports'
});

/**
 * First-time setup:
 * - Creates/locates the private Drive folder.
 * - Creates a long random shared secret if one does not already exist.
 * - Logs the secret once so it can be copied into the Cloudflare Pages
 *   Preview secret REPORT_INGEST_TOKEN.
 *
 * Do not put the returned secret into source code or a public repository.
 */
function setupEnglishTrainingReportIngest() {
  const props = PropertiesService.getScriptProperties();
  const folder = getOrCreateReportFolder_();
  let token = props.getProperty(REPORT_INGEST_CONFIG.tokenProperty);
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(REPORT_INGEST_CONFIG.tokenProperty, token);
  }
  Logger.log('Report folder ready: %s', folder.getName());
  Logger.log('REPORT_INGEST_TOKEN=%s', token);
  Logger.log('Copy the token into Cloudflare Pages project english-learning-grade7-test > Settings > Variables and Secrets > Preview.');
  return 'Setup complete. Copy REPORT_INGEST_TOKEN from the execution log.';
}

/**
 * Public Apps Script Web App endpoint.
 * The shared secret is checked before any Drive operation.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return jsonOutput_({ ok: false, error: 'busy' });

  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 400000) {
      return jsonOutput_({ ok: false, error: 'invalid_or_oversized_request' });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return jsonOutput_({ ok: false, error: 'invalid_json' });
    }

    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty(REPORT_INGEST_CONFIG.tokenProperty) || '';
    const suppliedToken = String(body && body.token || '');
    if (!expectedToken || !constantTimeEquals_(expectedToken, suppliedToken)) {
      return jsonOutput_({ ok: false, error: 'unauthorized' });
    }

    const payload = body && body.payload;
    if (!isValidIncomingReport_(payload)) {
      return jsonOutput_({ ok: false, error: 'invalid_report_payload' });
    }

    const reportId = payload.reportId;
    const jsonText = JSON.stringify(payload, null, 2);
    const fileProperty = REPORT_INGEST_CONFIG.filePropertyPrefix + reportId;
    const existingFileId = props.getProperty(fileProperty);
    let file;

    if (existingFileId) {
      file = DriveApp.getFileById(existingFileId);
      const existingText = file.getBlob().getDataAsString('UTF-8');
      if (existingText !== jsonText) {
        return jsonOutput_({ ok: false, error: 'report_id_conflict' });
      }
    } else {
      const folder = getOrCreateReportFolder_();
      const prefix = payload.testMode ? 'TEST_' : '';
      const date = String(payload.report.date || 'undated');
      const filename = prefix + 'EnglishTraining_' + date + '_' + reportId + '.json';
      file = folder.createFile(filename, jsonText, 'application/json');
      props.setProperty(fileProperty, file.getId());
    }

    return jsonOutput_({
      ok: true,
      reportId: reportId,
      storedAt: new Date().toISOString(),
      filename: file.getName()
    });
  } catch (err) {
    console.error('Report ingestion failed: ' + (err && err.message ? err.message : err));
    return jsonOutput_({ ok: false, error: 'report_storage_failed' });
  } finally {
    lock.releaseLock();
  }
}

function isValidIncomingReport_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.source !== 'string' || payload.source.indexOf('English Training') !== 0) return false;
  if (typeof payload.testMode !== 'boolean') return false;
  if (typeof payload.version !== 'string' || !payload.version) return false;
  if (typeof payload.reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.reportId)) return false;
  const report = payload.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (report.reportId !== payload.reportId) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.date || ''))) return false;
  if (['independent', 'practice', 'guided'].indexOf(report.mode) < 0) return false;
  if (report.completed !== 7 || !report.answers || typeof report.answers !== 'object') return false;
  return true;
}

function constantTimeEquals_(a, b) {
  const left = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(a), Utilities.Charset.UTF_8);
  const right = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(b), Utilities.Charset.UTF_8);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ^ right[i]);
  return diff === 0 && String(a).length === String(b).length;
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateReportFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(REPORT_INGEST_CONFIG.folderIdProperty);
  if (savedId) {
    try {
      return DriveApp.getFolderById(savedId);
    } catch (err) {
      props.deleteProperty(REPORT_INGEST_CONFIG.folderIdProperty);
    }
  }
  const folders = DriveApp.getFoldersByName(REPORT_INGEST_CONFIG.folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(REPORT_INGEST_CONFIG.folderName);
  props.setProperty(REPORT_INGEST_CONFIG.folderIdProperty, folder.getId());
  return folder;
}

function getStoredReportPayload_(reportId) {
  if (!reportId || !/^[0-9a-f-]{36}$/i.test(reportId)) return null;
  const props = PropertiesService.getScriptProperties();
  const fileId = props.getProperty(REPORT_INGEST_CONFIG.filePropertyPrefix + reportId);
  if (!fileId) return null;
  const payload = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'));
  if (!payload || payload.reportId !== reportId || !payload.report || payload.report.reportId !== reportId) {
    throw new Error('Stored JSON report does not match REPORT_ID.');
  }
  return payload;
}


/**
 * Retention policy:
 * - Real training JSON reports and their Gmail/PDF records: 12 calendar months.
 * - Completed technical test reports (testMode=true / [TEST]): 30 days.
 *
 * Drive stores the structured JSON files.
 * Gmail stores the original PDF attachments and the extracted-text companion mails.
 * Expired records are moved to the Trash, not hard-deleted immediately.
 */

const ENGLISH_TRAINING_RETENTION = Object.freeze({
  labelName: 'Englisch Lernen',
  testDays: 30,
  realMonths: 12,
  dailyTriggerHour: 3,
  triggerFunction: 'cleanupEnglishTrainingRetention'
});

function subtractUtcCalendarMonths_(date, months) {
  const result = new Date(date.getTime());
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0
  )).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

function isExpiredByRetention_(dateValue, isTest, now) {
  const timestamp = dateValue instanceof Date
    ? dateValue.getTime()
    : new Date(String(dateValue) + 'T00:00:00Z').getTime();

  if (!Number.isFinite(timestamp)) return false;

  const cutoff = isTest
    ? new Date(now.getTime() - ENGLISH_TRAINING_RETENTION.testDays * 24 * 60 * 60 * 1000)
    : subtractUtcCalendarMonths_(now, ENGLISH_TRAINING_RETENTION.realMonths);

  return timestamp < cutoff.getTime();
}

function getEnglishTrainingRetentionPlan_() {
  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  const allProperties = props.getProperties();
  const folderId = props.getProperty(REPORT_INGEST_CONFIG.folderIdProperty);
  const plan = {
    drive: [],
    gmail: [],
    skippedDrive: 0,
    skippedGmail: 0
  };

  // Drive: only JSON files referenced by the report-ID index and located
  // inside the dedicated English Training Reports folder are eligible.
  if (folderId) {
    Object.keys(allProperties)
      .filter(key => key.indexOf(REPORT_INGEST_CONFIG.filePropertyPrefix) === 0)
      .forEach(key => {
        const reportId = key.substring(REPORT_INGEST_CONFIG.filePropertyPrefix.length);
        const fileId = allProperties[key];

        try {
          const file = DriveApp.getFileById(fileId);
          if (file.isTrashed() ||
              file.getMimeType() !== 'application/json' ||
              !/^(TEST_)?EnglishTraining_.*\.json$/i.test(file.getName())) {
            plan.skippedDrive++;
            return;
          }

          let inExpectedFolder = false;
          const parents = file.getParents();
          while (parents.hasNext()) {
            if (parents.next().getId() === folderId) inExpectedFolder = true;
          }
          if (!inExpectedFolder) {
            plan.skippedDrive++;
            return;
          }

          const payload = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
          const report = payload && payload.report;
          if (!payload ||
              typeof payload.testMode !== 'boolean' ||
              payload.reportId !== reportId ||
              !report ||
              report.reportId !== reportId ||
              !/^\d{4}-\d{2}-\d{2}$/.test(String(report.date || ''))) {
            plan.skippedDrive++;
            return;
          }

          if (isExpiredByRetention_(report.date, payload.testMode, now)) {
            plan.drive.push({
              key: key,
              fileId: fileId,
              fileName: file.getName(),
              reportId: reportId,
              isTest: payload.testMode,
              reportDate: report.date
            });
          }
        } catch (error) {
          console.error('Retention Drive check skipped for ' + reportId + ': ' + error.message);
          plan.skippedDrive++;
        }
      });
  }

  // Gmail: the "Englisch Lernen" label is only applied after the mail/PDF
  // pairing and baseline checks succeeded. We retain/delete the original
  // message and the PDF-extracted companion independently by their age.
  const label = GmailApp.getUserLabelByName(ENGLISH_TRAINING_RETENTION.labelName);
  if (label) {
    label.getThreads().forEach(thread => {
      try {
        const messages = thread.getMessages();
        if (!messages.length) {
          plan.skippedGmail++;
          return;
        }

        let isTest = false;
        let latestMessageDate = new Date(0);

        messages.forEach(message => {
          const messageDate = message.getDate();
          if (messageDate && messageDate.getTime() > latestMessageDate.getTime()) {
            latestMessageDate = messageDate;
          }

          const subject = message.getSubject() || '';
          const plainBody = message.getPlainBody() || '';
          const testBySubject = /\[TEST\]/i.test(subject);
          const testByBody = /["']?testMode["']?\s*:\s*true\b/i.test(plainBody);
          const testByAttachment = message.getAttachments().some(attachment =>
            /^TEST_/i.test(attachment.getName() || '')
          );

          if (testBySubject || testByBody || testByAttachment) isTest = true;
        });

        if (isExpiredByRetention_(latestMessageDate, isTest, now)) {
          plan.gmail.push({
            thread: thread,
            threadId: thread.getId(),
            subject: messages[messages.length - 1].getSubject() || '(ohne Betreff)',
            isTest: isTest,
            latestMessageDate: latestMessageDate
          });
        }
      } catch (error) {
        console.error('Retention Gmail check skipped for thread ' + thread.getId() + ': ' + error.message);
        plan.skippedGmail++;
      }
    });
  } else {
    console.warn('Retention label not found: ' + ENGLISH_TRAINING_RETENTION.labelName);
  }

  return plan;
}

/**
 * Read-only preview. Run this first; it does not move or delete anything.
 */
function previewEnglishTrainingRetention() {
  const plan = getEnglishTrainingRetentionPlan_();

  Logger.log('=== ENGLISH TRAINING RETENTION PREVIEW (NO DELETION) ===');
  Logger.log('Drive JSON candidates: %s', plan.drive.length);
  plan.drive.forEach(item => Logger.log(
    'DRIVE WOULD MOVE TO TRASH | %s | test=%s | reportDate=%s',
    item.fileName, item.isTest, item.reportDate
  ));

  Logger.log('Gmail thread candidates: %s', plan.gmail.length);
  plan.gmail.forEach(item => Logger.log(
    'GMAIL WOULD MOVE TO TRASH | thread=%s | subject=%s | test=%s | latest=%s',
    item.threadId, item.subject, item.isTest, item.latestMessageDate.toISOString()
  ));

  Logger.log('Skipped Drive records: %s', plan.skippedDrive);
  Logger.log('Skipped Gmail threads: %s', plan.skippedGmail);
  Logger.log('Preview complete. No files or emails were changed.');
}

/**
 * Daily retention cleanup. Expired items are moved to Trash so they remain
 * recoverable for Google's normal Trash period before permanent deletion.
 */
function cleanupEnglishTrainingRetention() {
  const plan = getEnglishTrainingRetentionPlan_();
  const props = PropertiesService.getScriptProperties();
  let driveMoved = 0;
  let gmailMoved = 0;

  plan.drive.forEach(item => {
    try {
      const file = DriveApp.getFileById(item.fileId);
      file.setTrashed(true);
      props.deleteProperty(item.key);
      driveMoved++;
      Logger.log('Moved expired JSON to Trash: %s', item.fileName);
    } catch (error) {
      console.error('Could not move JSON to Trash (' + item.fileName + '): ' + error.message);
    }
  });

  plan.gmail.forEach(item => {
    try {
      item.thread.moveToTrash();
      gmailMoved++;
      Logger.log('Moved expired Gmail thread to Trash: %s', item.threadId);
    } catch (error) {
      console.error('Could not move Gmail thread to Trash (' + item.threadId + '): ' + error.message);
    }
  });

  Logger.log(
    'Retention cleanup complete. Drive JSON moved to Trash: %s; Gmail threads (PDFs/messages) moved to Trash: %s.',
    driveMoved,
    gmailMoved
  );
}

/**
 * Run once after reviewing previewEnglishTrainingRetention().
 * Installs one daily cleanup trigger at 03:00 Europe/Berlin (project timezone).
 */
function installEnglishTrainingRetention() {
  const existing = ScriptApp.getProjectTriggers().some(trigger =>
    trigger.getHandlerFunction() === ENGLISH_TRAINING_RETENTION.triggerFunction
  );

  if (!existing) {
    ScriptApp.newTrigger(ENGLISH_TRAINING_RETENTION.triggerFunction)
      .timeBased()
      .everyDays(1)
      .atHour(ENGLISH_TRAINING_RETENTION.dailyTriggerHour)
      .create();
  }

  Logger.log(
    'English Training retention trigger is %s.',
    existing ? 'already installed' : 'installed'
  );
  Logger.log('Daily cleanup window: 03:00–04:00 Europe/Berlin.');
}

/** Run once only if the existing five-minute PDF trigger is missing. */
function installPdfBridge() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PDF_BRIDGE_START_AFTER')) {
    props.setProperty('PDF_BRIDGE_START_AFTER', String(Date.now()));
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === PDF_BRIDGE_CONFIG.triggerFunction)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(PDF_BRIDGE_CONFIG.triggerFunction)
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('PDF bridge installed. The JSON endpoint is handled by doPost().');
}

function processEnglishTrainingPdfs() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;

  try {
    const props = PropertiesService.getScriptProperties();
    const startAfter = Number(props.getProperty('PDF_BRIDGE_START_AFTER') || 0);
    const readyLabel = getOrCreateLabel_(PDF_BRIDGE_CONFIG.readyLabel);
    const errorLabel = getOrCreateLabel_(PDF_BRIDGE_CONFIG.errorLabel);
    const threads = GmailApp.search(PDF_BRIDGE_CONFIG.searchQuery, 0, PDF_BRIDGE_CONFIG.maxThreadsPerRun);

    threads.forEach(thread => {
      thread.getMessages().forEach(message => {
        const subject = message.getSubject() || '';
        const messageDate = message.getDate().getTime();
        const plainBody = message.getPlainBody() || '';

        if (messageDate <= startAfter) return;
        if (/^\s*\[PDF-EXTRACTED\]/i.test(subject)) return;

        const attachments = message.getAttachments({
          includeInlineImages: false,
          includeAttachments: true
        });
        const pdfs = attachments.filter(a => {
          const name = a.getName() || '';
          const type = (a.getContentType() || '').toLowerCase();
          return /\.pdf$/i.test(name) && (!type || type === 'application/pdf');
        });
        if (!pdfs.length) return;

        const attachmentNames = pdfs.map(a => a.getName()).join(' ');
        const isTraining = /englisch\s*training|english\s*training|englisch\s*traning/i.test(subject + ' ' + plainBody + ' ' + attachmentNames);
        if (!isTraining) return;

        const reportIdMatch = plainBody.match(/(?:^|\n)\s*REPORT_ID=([0-9a-f-]{36})\s*(?:$|\n)/i);
        const reportId = reportIdMatch ? reportIdMatch[1] : null;

        pdfs.forEach(pdf => {
          const key = 'PDF_BRIDGE_DONE_' + message.getId() + '_' + pdf.getName();
          if (props.getProperty(key)) return;

          let tempDocId = null;
          try {
            const size = pdf.getSize();
            if (size > PDF_BRIDGE_CONFIG.maxPdfBytes) {
              throw new Error('PDF is larger than 2 MB; automatic Drive text conversion was skipped.');
            }

            let reportPayload = null;
            if (reportId) reportPayload = getStoredReportPayload_(reportId);
            if (!reportPayload) reportPayload = extractLegacyReportPayload_(plainBody);
            if (!reportPayload) {
              throw new Error(reportId
                ? 'JSON report for REPORT_ID is not stored yet. The PDF bridge will retry.'
                : 'No structured JSON report or REPORT_ID found in the original message.');
            }
            if (reportId && reportPayload.reportId !== reportId) {
              throw new Error('The JSON report ID does not match the original email REPORT_ID.');
            }

            const blob = pdf.copyBlob().setName(pdf.getName()).setContentType('application/pdf');
            const created = Drive.Files.create(
              {
                name: 'TEMP_PDF_TEXT_' + message.getId(),
                mimeType: 'application/vnd.google-apps.document'
              },
              blob,
              { fields: 'id,name,mimeType' }
            );
            tempDocId = created.id;
            if (!tempDocId) throw new Error('Google Drive did not return a converted document ID.');

            let extractedText = '';
            let lastError = null;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                Utilities.sleep(1000 * (attempt + 1));
                extractedText = DocumentApp.openById(tempDocId).getBody().getText().trim();
                if (extractedText.length >= 100) break;
              } catch (err) {
                lastError = err;
              }
            }
            if (extractedText.length < 100) {
              throw new Error('PDF conversion returned too little readable text.' + (lastError ? ' ' + lastError.message : ''));
            }

            const reportJson = JSON.stringify(reportPayload, null, 2);
            const marker = [
              'PDF_EXTRACTED_TEXT_VERSION=2',
              'SOURCE_MESSAGE_ID=' + message.getId(),
              'SOURCE_SUBJECT=' + subject,
              'SOURCE_DATE=' + message.getDate().toISOString(),
              'PDF_FILENAME=' + pdf.getName(),
              'PDF_SIZE_BYTES=' + size,
              'REPORT_ID=' + (reportPayload.reportId || reportId || ''),
              '',
              '===== ORIGINAL EMAIL BODY =====',
              plainBody,
              '',
              '===== STRUCTURED JSON REPORT =====',
              reportJson,
              '===== END OF STRUCTURED JSON REPORT =====',
              '',
              '===== PDF TEXT EXTRACTED FROM THE ATTACHMENT =====',
              extractedText,
              '===== END OF EXTRACTED PDF TEXT ====='
            ].join('\n');

            GmailApp.sendEmail(
              PDF_BRIDGE_CONFIG.recipient,
              '[PDF-EXTRACTED] ' + subject,
              marker
            );

            thread.addLabel(readyLabel);
            thread.removeLabel(errorLabel);
            props.setProperty(key, new Date().toISOString());
            Logger.log('Extracted PDF text and attached report JSON for message %s (%s chars).', message.getId(), extractedText.length);
          } catch (err) {
            thread.addLabel(errorLabel);
            Logger.log('PDF extraction failed for message %s / %s: %s', message.getId(), pdf.getName(), err.message);
          } finally {
            if (tempDocId) {
              try {
                DriveApp.getFileById(tempDocId).setTrashed(true);
              } catch (cleanupError) {
                Logger.log('Could not trash temporary Doc %s: %s', tempDocId, cleanupError.message);
              }
            }
          }
        });
      });
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads the old mail format for backward compatibility.
 * The JSON can be followed by the human-readable email closing, so extract
 * exactly one balanced JSON object/array while respecting escaped strings.
 */
function extractLegacyReportPayload_(body) {
  const marker = 'Berichtsdaten zur automatisierten Prüfung (JSON):';
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) return null;
  const remainder = body.slice(markerIndex + marker.length);
  const start = remainder.search(/[\[{]/);
  if (start < 0) return null;

  const opening = remainder[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < remainder.length; i++) {
    const ch = remainder[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opening) depth++;
    else if (ch === closing) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(remainder.slice(start, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

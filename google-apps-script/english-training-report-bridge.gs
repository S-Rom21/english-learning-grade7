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

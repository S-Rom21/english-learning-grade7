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

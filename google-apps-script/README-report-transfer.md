# English Training – automatic report transfer (test rollout)

This branch adds a protected JSON upload endpoint while retaining the existing PDF-by-email workflow.

## What happens after a completed session

1. The browser creates one structured report with a unique `reportId`.
2. The browser queues the report locally and posts it to `/api/report`.
3. The Pages Function validates the Cloudflare Access JWT and forwards the report to the Apps Script web app.
4. Apps Script checks a shared secret and stores the JSON as a private file in the Google Drive folder `English Training Reports`.
5. The learner still opens the tablet's standard email app and manually attaches the PDF, exactly as before. If JSON storage succeeded, the email contains the `REPORT_ID` only. If JSON storage is not yet configured or upload failed, the existing full-JSON email fallback remains enabled.
6. The existing PDF bridge extracts the PDF text and retrieves the JSON by `REPORT_ID`. The `[PDF-EXTRACTED]` companion message carries both, so the current verification process can compare the structured report with the PDF.
7. A report is not removed from the browser's pending queue until Apps Script confirms the same `reportId`. Repeated upload attempts are idempotent.

Additional practice sessions use exactly the same report pipeline and are marked `mode: "practice"`. Test deployments retain `testMode: true`; those reports must never update the learner's production progress.

## One-time setup in Google Apps Script

The Apps Script source is in `google-apps-script/english-training-report-bridge.gs`.

1. Open the **existing English Training PDF bridge Apps Script project**.
2. Replace the old PDF bridge source file with the complete source from `english-training-report-bridge.gs`. Do not add a second copy alongside the old bridge, because the trigger and handler names are intentionally retained.
3. Keep the existing advanced Drive API service enabled (symbol `Drive`). It is still required for PDF-to-Google-Docs text extraction.
4. In the Apps Script editor, select and run `setupEnglishTrainingReportIngest` once. Approve the Google Drive permission request. The function creates (or reuses) the private Drive folder `English Training Reports` and stores a random shared secret in Script Properties.
5. Open the execution log and copy the value after `REPORT_INGEST_TOKEN=`. Keep it private.
6. Deploy > New deployment > **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy and copy the Web app URL ending in `/exec`.

The endpoint is publicly reachable so Cloudflare can call it server-to-server, but it rejects requests without the long random shared secret. The secret is not embedded in the webpage or source code.

The existing five-minute `processEnglishTrainingPdfs` trigger and its `PDF_BRIDGE_START_AFTER` property should remain in the Apps Script project. The new source preserves both. Do not reset the start-after property; otherwise older emails may be reprocessed.

## One-time setup in Cloudflare Pages (preview only)

In Cloudflare Dashboard:

1. Open Pages project **english-learning-grade7-test**.
2. Go to Settings > Variables and Secrets.
3. Under the **Preview** environment, add:
   - `REPORT_INGEST_URL` – the Apps Script Web app URL (plain-text variable).
   - `REPORT_INGEST_TOKEN` – the value copied from the Apps Script log (encrypted secret).
4. Save and trigger a new preview deployment from this branch.

Do not add these values to GitHub or to the HTML files. The production Pages project and production environment are not changed by this branch.

## Test procedure

Use the latest protected test preview and sign in through Cloudflare Access.

1. On a Thursday, for example, confirm that **Reguläres Training starten** is disabled and the status explains the fixed days.
2. Confirm **Zusätzliches Training!** remains available.
3. Complete a short additional session. It follows the same seven sections, scoring, review queue, history and report workflow as regular training.
4. Confirm the report status says JSON was transferred. If it says the transfer is pending, the queue keeps the report locally and the email retains the full JSON fallback.
5. Prepare the email in the tablet's standard mail app and attach the PDF as usual.
6. The Apps Script PDF trigger should create a `[PDF-EXTRACTED]` companion containing `SOURCE_MESSAGE_ID`, `REPORT_ID`, the complete structured JSON report and the extracted PDF text.
7. The Gmail report check must compare the companion's JSON with the PDF before archiving. Test reports are archived only after successful validation, but are excluded from learner-progress calculations.

## Security and recovery notes

- The browser only calls the same-origin Pages Function. The function validates the Cloudflare Access JWT (signature, issuer, audience and expiry) before forwarding data.
- Both Cloudflare shared secret and Apps Script token are server-side settings. No secrets are committed to Git.
- Apps Script saves JSON in the owner's private Drive; it does not create public Drive links.
- If the network is offline or the receiving endpoint is unavailable, the JSON remains in the browser's pending queue. The app retries when the connection returns or on the next load.
- Until the Apps Script Web app is deployed and the two Preview variables are configured, the function deliberately returns `503 report_ingest_not_configured`. In that state the existing full-JSON mail fallback keeps the old PDF verification flow working.
- The production website is not deployed from this feature branch and must not be changed until the user explicitly approves a production rollout.

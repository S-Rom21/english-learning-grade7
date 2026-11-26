const ACCESS_TEAM = "https://family-learning-hub.cloudflareaccess.com";
const ALLOWED_AUDS = new Set([
  "97580523922a7fae49d08f0b72c32cf7700330da8115ae1d4e80ef2a73e7865a",
  "dd5921a0a1aeff49144d1e3856b446a58a41343314ae2151f6774d0b2a604557"
]);
const MAX_BODY_BYTES = 300_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function verifyAccessJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  let header;
  let claims;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || !header.kid) return false;

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ACCESS_TEAM) return false;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some(aud => ALLOWED_AUDS.has(aud))) return false;
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return false;
  if (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) return false;

  const jwksResponse = await fetch(ACCESS_TEAM + "/cdn-cgi/access/certs", {
    headers: { "Accept": "application/json" }
  });
  if (!jwksResponse.ok) return false;
  const jwks = await jwksResponse.json();
  const jwk = (jwks.keys || []).find(key => key.kid === header.kid);
  if (!jwk) return false;

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
}

function isValidReportPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.source !== "string" || !payload.source.startsWith("English Training")) return false;
  if (typeof payload.testMode !== "boolean") return false;
  if (typeof payload.version !== "string" || !payload.version) return false;
  if (typeof payload.reportId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.reportId)) return false;
  const report = payload.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  if (report.reportId !== payload.reportId) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.date || ""))) return false;
  if (!["independent", "practice", "guided"].includes(report.mode)) return false;
  if (report.completed !== 7 || !report.answers || typeof report.answers !== "object") return false;
  return true;
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "origin_not_allowed" }, 403);
  }

  const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!accessJwt) return json({ ok: false, error: "access_authentication_required" }, 401);

  try {
    if (!(await verifyAccessJwt(accessJwt))) {
      return json({ ok: false, error: "access_authentication_invalid" }, 401);
    }
  } catch {
    return json({ ok: false, error: "access_token_validation_failed" }, 401);
  }

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: "report_too_large" }, 413);

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "report_too_large" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // The browser posts the report object directly. Also accept the wrapped
  // { payload } shape so older clients and server-side callers remain compatible.
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : body;
  if (!isValidReportPayload(payload)) {
    return json({ ok: false, error: "invalid_report_payload" }, 400);
  }

  if (!env.REPORT_INGEST_URL || !env.REPORT_INGEST_TOKEN) {
    return json({ ok: false, error: "report_ingest_not_configured" }, 503);
  }

  const delays = [0, 400, 1200];
  let lastFailure = {
    code: "unknown_upstream_failure",
    status: null,
    contentType: null,
    redirected: false
  };

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) {
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }

    try {
      const upstream = await fetch(env.REPORT_INGEST_URL, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: env.REPORT_INGEST_TOKEN,
          payload
        })
      });

      const contentType = upstream.headers.get("Content-Type") || "";
      const responseText = await upstream.text();
      let result = null;
      try {
        result = JSON.parse(responseText);
      } catch {
        // Apps Script ContentService normally returns JSON after a redirect.
      }

      if (upstream.ok && result?.ok && result.reportId === payload.reportId) {
        return json({
          ok: true,
          reportId: payload.reportId,
          storedAt: result.storedAt || new Date().toISOString()
        });
      }

      lastFailure = {
        code: typeof result?.error === "string"
          ? result.error
          : (result ? "invalid_apps_script_response" : "apps_script_non_json_response"),
        status: upstream.status,
        contentType: contentType.slice(0, 80),
        redirected: upstream.redirected
      };

      const retryable =
        upstream.status === 404 ||
        upstream.status === 429 ||
        upstream.status >= 500 ||
        lastFailure.code === "busy" ||
        (upstream.redirected && !result);

      if (!retryable) break;
    } catch (error) {
      lastFailure = {
        code: "apps_script_network_error",
        status: null,
        contentType: null,
        redirected: false
      };
    }
  }

  return json({
    ok: false,
    error: "report_storage_failed",
    upstreamError: lastFailure.code,
    upstreamStatus: lastFailure.status,
    upstreamContentType: lastFailure.contentType,
    upstreamRedirected: lastFailure.redirected
  }, 502);
}

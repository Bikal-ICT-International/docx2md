// ============================================================================
// SECURITY: Rate Limiting Storage & Configuration
// ============================================================================
const rateLimitStore = new Map();
const RATE_LIMITS = {
  upload: { requests: 15, window: 3600 },     // 15 uploads per hour
  status: { requests: 30, window: 60 },       // 30 status checks per minute
  artifact: { requests: 15, window: 3600 }    // 10 downloads per hour
};

// ============================================================================
// SECURITY: CORS Configuration
// ============================================================================
const ALLOWED_ORIGINS = [
  "https://shrestha.cv",                      // Custom domain
  "https://docx2md.shrestha.cv",                      // Custom domain
  "http://localhost:3000"                     // Local development only
];

// ============================================================================
// SECURITY: File Upload Validation
// ============================================================================
const VALIDATION_CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024,  // 50MB
  MAX_FILENAME_LENGTH: 255,
  ALLOWED_EXTENSIONS: ['.docx'],
  SAFE_CHARS_PATTERN: /^[a-zA-Z0-9._\- ]+$/,
};

// ============================================================================
// SECURITY: Periodic Cleanup (runs weekly in Cloudflare)
// ============================================================================
setInterval(() => {
  const now = Date.now();
  const maxWindow = Math.max(...Object.values(RATE_LIMITS).map(r => r.window)) * 1000;

  for (const [key, timestamps] of rateLimitStore.entries()) {
    const recentTimestamps = timestamps.filter(t => now - t < maxWindow);
    if (recentTimestamps.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, recentTimestamps);
    }
  }
}, 3600000); // Run every hour

export default {
  async fetch(request, env) {
    const { method, url } = request;
    const { pathname } = new URL(url);

    if (method === "OPTIONS") {
      const corsHeaders = getCorsHeaders(request);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const corsHeaders = getCorsHeaders(request);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';

      // ✅ Security Check: Rate Limit
      if (pathname === "/upload" && method === "POST") {
        if (!checkRateLimit(ip, 'upload')) {
          return json(
            { ok: false, error: 'Rate limited: Max 5 uploads per hour. Try again later.' },
            429,
            corsHeaders
          );
        }
      }

      if (pathname === "/status" && method === "GET") {
        if (!checkRateLimit(ip, 'status')) {
          return json(
            { ok: false, error: 'Rate limited: Max 30 status checks per minute.' },
            429,
            corsHeaders
          );
        }
      }

      if (pathname === "/artifact" && method === "GET") {
        if (!checkRateLimit(ip, 'artifact')) {
          return json(
            { ok: false, error: 'Rate limited: Max 10 artifact downloads per hour.' },
            429,
            corsHeaders
          );
        }
      }
      if (pathname === "/upload" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");

        // ✅ Security: Validate input
        const validation = validateFile(file);
        if (!validation.valid) {
          return json(
            { ok: false, error: 'Upload validation failed', details: validation.errors },
            400,
            corsHeaders
          );
        }

        const signatureValidation = await validateDocxSignature(file);
        if (!signatureValidation.valid) {
          return json(
            { ok: false, error: 'Upload validation failed', details: signatureValidation.errors },
            400,
            corsHeaders
          );
        }

        const safeFilename = validation.sanitized;

        const fileForm = new FormData();
        fileForm.append("file", file, safeFilename);

        const uploadRes = await fetch("https://tmpfiles.org/api/v1/upload", {
          method: "POST",
          body: fileForm,
        });
        const uploadJson = await uploadRes.json().catch(() => null);
        const pageUrl = uploadJson?.data?.url || uploadJson?.url || null;
        const directUrl = pageUrl
          ? pageUrl.replace("://tmpfiles.org/", "://tmpfiles.org/dl/")
          : null;
        if (!uploadRes.ok || !uploadJson || !directUrl) {
          return json({ ok: false, error: "Temporary upload failed" }, 502, corsHeaders);
        }

        let tempDownloadUrl;
        try {
          tempDownloadUrl = new URL(directUrl);
        } catch {
          return json({ ok: false, error: "Temporary upload returned an invalid download URL" }, 502, corsHeaders);
        }

        if (
          tempDownloadUrl.protocol !== "https:" ||
          tempDownloadUrl.hostname !== "tmpfiles.org" ||
          !tempDownloadUrl.pathname.startsWith("/dl/")
        ) {
          return json({ ok: false, error: "Temporary upload returned an unexpected download URL" }, 502, corsHeaders);
        }

        const owner = env.GITHUB_OWNER;
        const repo = env.GITHUB_REPO;
        const branch = env.GITHUB_BRANCH || "main";
        const token = env.GITHUB_TOKEN;
        if (!owner || !repo || !token) {
          return json({ ok: false, error: "Worker not configured" }, 500, corsHeaders);
        }

        const dispatchRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/convert-docx.yml/dispatches`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "docx2md-worker",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ref: branch,
              inputs: {
                docx_url: directUrl,
                docx_name: safeFilename,
              },
            }),
          }
        );

        if (!dispatchRes.ok) {
          const text = await dispatchRes.text();
          return json({ ok: false, error: `Workflow dispatch failed: ${text}` }, 502, corsHeaders);
        }

        return json({ ok: true }, 200, corsHeaders);
      }

      if (pathname === "/status" && method === "GET") {
        const run = await getLatestRun(env);
        if (!run) {
          return json({ status: "unknown", conclusion: "pending" }, 200, corsHeaders);
        }
        return json(
          { status: run.status || "unknown", conclusion: run.conclusion || "pending" },
          200,
          corsHeaders
        );
      }

      if (pathname === "/artifact" && method === "GET") {
        const run = await getLatestRun(env, true);
        if (!run) {
          return new Response("No completed runs yet", { status: 404, headers: corsHeaders });
        }

        const artifactsRes = await githubRequest(
          env,
          `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${run.id}/artifacts`
        );
        const artifactsJson = await artifactsRes.json();
        const artifacts = artifactsJson.artifacts || [];
        if (!artifacts.length) {
          return new Response("No artifacts yet", { status: 404, headers: corsHeaders });
        }

        const artifact = artifacts.find((a) => a.name === "markdown-and-media") || artifacts[0];
        const downloadRes = await githubRequest(env, artifact.archive_download_url);

        const headers = new Headers(downloadRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(downloadRes.body, {
          status: downloadRes.status,
          headers,
        });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500, corsHeaders);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function githubRequest(env, url) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error("Worker not configured");
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "docx2md-worker",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "GitHub request failed");
  }
  return res;
}

async function getLatestRun(env, completedOnly = false) {
  const branch = env.GITHUB_BRANCH || "main";
  const status = completedOnly ? "completed" : "";
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/convert-docx.yml/runs?branch=${encodeURIComponent(
    branch
  )}${status ? `&status=${status}` : ""}&per_page=1`;
  const res = await githubRequest(env, url);
  const json = await res.json();
  const runs = json.workflow_runs || [];
  return runs[0] || null;
}

// ============================================================================
// SECURITY FUNCTIONS
// ============================================================================

/**
 * ✅ SECURITY: Check CORS origin against whitelist
 * Returns CORS headers based on request origin
 */
function getCorsHeaders(request) {
  const origin = request.headers.get('origin');

  // Check if origin is in allowed list
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }

  // Unknown origin - block it
  return {
    "Access-Control-Allow-Origin": "null",
  };
}

/**
 * ✅ SECURITY: Check rate limit for IP and endpoint
 * Returns true if request is within limits, false if rate limited
 */
function checkRateLimit(ip, endpoint) {
  if (!ip) return true;

  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const limit = RATE_LIMITS[endpoint];

  if (!limit) return true;

  // Get stored timestamps for this IP:endpoint
  let timestamps = rateLimitStore.get(key) || [];

  // Remove old timestamps outside the time window
  const windowMs = limit.window * 1000;
  const recentTimestamps = timestamps.filter(t => now - t < windowMs);

  // Check if limit exceeded
  if (recentTimestamps.length >= limit.requests) {
    return false;  // Rate limited
  }

  // Add this request's timestamp
  recentTimestamps.push(now);
  rateLimitStore.set(key, recentTimestamps);

  return true;  // OK
}

/**
 * ✅ SECURITY: Sanitize filename to prevent attacks
 * Removes dangerous characters and enforces length limits
 */
function sanitizeFilename(filename) {
  if (!filename) return 'document.docx';

  // Get extension
  const ext = filename.slice(filename.lastIndexOf('.')) || '.docx';
  const name = filename.replace(/\.[^/.]+$/, '');

  // Remove potentially dangerous characters
  let safe = name
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')  // Replace unsafe chars
    .replace(/\s+/g, '_')                // Replace spaces
    .replace(/_{2,}/g, '_')              // Multiple underscores → single
    .substring(0, VALIDATION_CONFIG.MAX_FILENAME_LENGTH - ext.length);

  // Remove leading/trailing special chars
  safe = safe.replace(/^[-_.]+|[-_.]+$/g, '');

  if (!safe) safe = 'document';

  return safe + ext;
}

async function validateDocxSignature(file) {
  const errors = [];
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip =
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    (
      (header[2] === 0x03 && header[3] === 0x04) ||
      (header[2] === 0x05 && header[3] === 0x06) ||
      (header[2] === 0x07 && header[3] === 0x08)
    );

  if (!isZip) {
    errors.push('File does not look like a DOCX/ZIP package');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * ✅ SECURITY: Comprehensive file validation
 * Checks size, extension, format, and filename
 */
function validateFile(file) {
  const errors = [];
  const warnings = [];

  // 1. File exists
  if (!file) {
    errors.push('No file provided');
    return { valid: false, errors, warnings };
  }

  // 2. File has name
  if (!file.name || file.name.trim() === '') {
    errors.push('File must have a name');
    return { valid: false, errors, warnings };
  }

  const filename = file.name.toLowerCase();

  // 3. Check extension
  const hasValidExtension = VALIDATION_CONFIG.ALLOWED_EXTENSIONS.some(ext =>
    filename.endsWith(ext)
  );
  if (!hasValidExtension) {
    const ext = filename.slice(filename.lastIndexOf('.')) || 'none';
    errors.push(`File must be a .docx file. Got: ${ext}`);
  }

  // 4. Check file size - not empty
  if (file.size === 0) {
    errors.push('File is empty (0 bytes)');
  }

  // 5. Check file size - not too large
  if (file.size > VALIDATION_CONFIG.MAX_FILE_SIZE) {
    errors.push(
      `File is too large: ${(file.size / 1024 / 1024).toFixed(2)}MB. ` +
      `Maximum: ${VALIDATION_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // 6. Check MIME type if provided
  if (file.type) {
    const validMimeTypes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/zip'
    ];

    if (!validMimeTypes.some(type => file.type.includes(type))) {
      warnings.push(
        `Unexpected file type: ${file.type}. ` +
        `Expected Office document format.`
      );
    }
  }

  // 7. Filename length warning
  if (file.name.length > VALIDATION_CONFIG.MAX_FILENAME_LENGTH) {
    warnings.push(
      `Filename is very long (${file.name.length} chars). ` +
      `It will be truncated.`
    );
  }

  // 8. Special characters warning
  if (!VALIDATION_CONFIG.SAFE_CHARS_PATTERN.test(file.name.replace(/.[^.]*$/, ''))) {
    warnings.push(
      'Filename contains special characters. ' +
      'They will be replaced with underscores.'
    );
  }

  // 9. Path traversal check (critical)
  if (file.name.includes('../') || file.name.includes('..\\')) {
    errors.push('Filename cannot contain path traversal sequences (..)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sanitized: sanitizeFilename(file.name)
  };
}

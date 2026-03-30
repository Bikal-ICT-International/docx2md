export default {
  async fetch(request, env) {
    const { method, url } = request;
    const { pathname } = new URL(url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (pathname === "/upload" && method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!file) {
          return json({ ok: false, error: "Missing file" }, 400, corsHeaders);
        }

        const fileForm = new FormData();
        fileForm.append("file", file, file.name || "upload.docx");
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
                docx_name: file.name || "upload.docx",
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

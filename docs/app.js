const els = {
  owner: document.getElementById("owner"),
  repo: document.getElementById("repo"),
  branch: document.getElementById("branch"),
  token: document.getElementById("token"),
  save: document.getElementById("save"),
  clear: document.getElementById("clear"),
  file: document.getElementById("file"),
  upload: document.getElementById("upload"),
  download: document.getElementById("download"),
  check: document.getElementById("check"),
  status: document.getElementById("status"),
  editor: document.getElementById("editor"),
  preview: document.getElementById("preview"),
  addImage: document.getElementById("add-image"),
  imageFile: document.getElementById("image-file"),
  fullscreen: document.getElementById("fullscreen"),
  fullscreenOverlay: document.getElementById("fullscreen-overlay"),
  exitFullscreen: document.getElementById("exit-fullscreen"),
  fullscreenContent: document.getElementById("fullscreen-content"),
};

const storageKey = "docx-md-config";
const lastDispatchKey = "docx-md-last-dispatch";
let mediaUrlMap = new Map();
let mediaBlobUrls = [];

function setStatus(message) {
  const now = new Date().toLocaleTimeString();
  els.status.textContent = `[${now}] ${message}`;
}

function loadConfig() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;
  try {
    const cfg = JSON.parse(raw);
    els.owner.value = cfg.owner || "";
    els.repo.value = cfg.repo || "";
    els.branch.value = cfg.branch || "main";
    els.token.value = cfg.token || "";
  } catch {
    // ignore
  }
}

function saveConfig() {
  const cfg = {
    owner: els.owner.value.trim(),
    repo: els.repo.value.trim(),
    branch: els.branch.value.trim() || "main",
    token: els.token.value.trim(),
  };
  localStorage.setItem(storageKey, JSON.stringify(cfg));
  setStatus("Saved configuration.");
  refreshButtons();
}

function clearConfig() {
  localStorage.removeItem(storageKey);
  els.owner.value = "";
  els.repo.value = "";
  els.branch.value = "main";
  els.token.value = "";
  setStatus("Cleared configuration.");
  refreshButtons();
}

function refreshButtons() {
  const ready = els.owner.value && els.repo.value && els.token.value;
  els.upload.disabled = !ready || !els.file.files.length;
  els.download.disabled = !ready;
  els.check.disabled = !ready;
}

function revokeMediaUrls() {
  mediaBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaBlobUrls = [];
  mediaUrlMap = new Map();
}

function rewriteImageLinks(md) {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, rawUrl) => {
    const cleanUrl = rawUrl.trim().replace(/^["']|["']$/g, "");
    const key = cleanUrl.split(/[\\/]/).pop();
    const mapped =
      mediaUrlMap.get(cleanUrl) || mediaUrlMap.get(key) || mediaUrlMap.get(decodeURIComponent(key));
    if (!mapped) return match;
    return `![${alt}](${mapped})`;
  });
}

function renderMarkdown(md) {
  if (!window.marked) {
    els.preview.textContent = "Markdown renderer not loaded.";
    return;
  }
  const rewritten = rewriteImageLinks(md);
  const html = window.marked.parse(rewritten);
  els.preview.innerHTML = html;
  if (els.fullscreenContent) {
    els.fullscreenContent.innerHTML = html;
  }
}

async function githubRequest(path, options = {}) {
  const token = els.token.value.trim();
  const base = "https://api.github.com";
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...options.headers,
  };
  const res = await fetch(`${base}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res;
}

async function uploadDocx() {
  const file = els.file.files[0];
  if (!file) return;
  const branch = els.branch.value.trim() || "main";
  setStatus("Uploading to temporary file host...");

  const form = new FormData();
  form.append("file", file, file.name);

  const uploadRes = await fetch("https://file.io", {
    method: "POST",
    body: form,
  });
  const rawText = await uploadRes.text();
  let uploadJson = null;
  try {
    uploadJson = rawText ? JSON.parse(rawText) : null;
  } catch {
    uploadJson = null;
  }
  if (!uploadRes.ok || !uploadJson || !uploadJson.success || !uploadJson.link) {
    throw new Error("Temporary upload failed. Try again.");
  }

  setStatus("Triggering GitHub Action...");
  const dispatchBody = {
    ref: branch,
    inputs: {
      docx_url: uploadJson.link,
      docx_name: file.name,
    },
  };

  await githubRequest(
    `/repos/${encodeURIComponent(els.owner.value.trim())}/${encodeURIComponent(
      els.repo.value.trim()
    )}/actions/workflows/convert-docx.yml/dispatches`,
    {
      method: "POST",
      body: JSON.stringify(dispatchBody),
    }
  );

  localStorage.setItem(lastDispatchKey, String(Date.now()));
  setStatus("Upload complete. Conversion started in GitHub Actions.");
}

async function downloadLatestArtifact() {
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  const branch = els.branch.value.trim() || "main";
  const lastDispatch = Number(localStorage.getItem(lastDispatchKey) || "0");
  setStatus("Finding latest completed run...");

  const runsRes = await githubRequest(
    `/repos/${owner}/${repo}/actions/workflows/convert-docx.yml/runs?branch=${encodeURIComponent(
      branch
    )}&status=completed&per_page=5`
  );
  const runsJson = await runsRes.json();
  if (!runsJson.workflow_runs || runsJson.workflow_runs.length === 0) {
    setStatus("No completed runs found yet. Try again in a minute.");
    return;
  }

  const matchingRun =
    runsJson.workflow_runs.find((run) => {
      const created = Date.parse(run.created_at || "");
      return lastDispatch && created >= lastDispatch - 120000;
    }) || runsJson.workflow_runs[0];

  const artifactsRes = await githubRequest(
    `/repos/${owner}/${repo}/actions/runs/${matchingRun.id}/artifacts`
  );
  const artifactsJson = await artifactsRes.json();
  if (!artifactsJson.artifacts || artifactsJson.artifacts.length === 0) {
    setStatus("No artifacts found for that run yet. Try again shortly.");
    return;
  }

  const artifact =
    artifactsJson.artifacts.find((a) => a.name === "markdown-and-media") ||
    artifactsJson.artifacts[0];
  const downloadUrl = artifact.archive_download_url;
  setStatus(`Downloading artifact: ${artifact.name}...`);

  const dlRes = await githubRequest(downloadUrl, { method: "GET" });
  const blob = await dlRes.blob();
  const arrayBuffer = await blob.arrayBuffer();

  if (window.JSZip) {
    revokeMediaUrls();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    let mdFile = null;
    zip.forEach((path, entry) => {
      if (!entry.dir && path.toLowerCase().endsWith(".md") && !mdFile) {
        mdFile = entry;
      }
      if (!entry.dir && path.toLowerCase().includes("/media/")) {
        const name = path.split("/").pop();
        mediaUrlMap.set(path, null);
        mediaUrlMap.set(name, null);
      }
    });

    const mediaPromises = [];
    zip.forEach((path, entry) => {
      if (!entry.dir && path.toLowerCase().includes("/media/")) {
        mediaPromises.push(
          entry.async("blob").then((fileBlob) => {
            const url = URL.createObjectURL(fileBlob);
            mediaBlobUrls.push(url);
            const name = path.split("/").pop();
            mediaUrlMap.set(path, url);
            mediaUrlMap.set(name, url);
          })
        );
      }
    });
    await Promise.all(mediaPromises);

    if (mdFile) {
      const mdText = await mdFile.async("text");
      els.editor.value = mdText;
      renderMarkdown(mdText);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${artifact.name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("Download started and preview loaded.");
}

async function checkLatestRun() {
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  const branch = els.branch.value.trim() || "main";
  const lastDispatch = Number(localStorage.getItem(lastDispatchKey) || "0");
  setStatus("Checking workflow status...");

  const runsRes = await githubRequest(
    `/repos/${owner}/${repo}/actions/workflows/convert-docx.yml/runs?branch=${encodeURIComponent(
      branch
    )}&per_page=5`
  );
  const runsJson = await runsRes.json();
  if (!runsJson.workflow_runs || runsJson.workflow_runs.length === 0) {
    setStatus("No runs found yet.");
    return;
  }

  const run =
    runsJson.workflow_runs.find((r) => {
      const created = Date.parse(r.created_at || "");
      return lastDispatch && created >= lastDispatch - 120000;
    }) || runsJson.workflow_runs[0];

  const status = run.status || "unknown";
  const conclusion = run.conclusion || "pending";
  setStatus(`Latest run status: ${status} (${conclusion}).`);
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = `${before}${text}${after}`;
  const caret = start + text.length;
  textarea.setSelectionRange(caret, caret);
}

els.save.addEventListener("click", saveConfig);
els.clear.addEventListener("click", clearConfig);
els.file.addEventListener("change", refreshButtons);
[els.owner, els.repo, els.branch, els.token].forEach((el) => {
  el.addEventListener("input", refreshButtons);
});

els.upload.addEventListener("click", () => {
  uploadDocx().catch((err) => setStatus(err.message));
});

els.download.addEventListener("click", () => {
  downloadLatestArtifact().catch((err) => setStatus(err.message));
});

els.check.addEventListener("click", () => {
  checkLatestRun().catch((err) => setStatus(err.message));
});

els.editor.addEventListener("input", (event) => {
  renderMarkdown(event.target.value || "");
});

els.addImage.addEventListener("click", () => {
  if (els.imageFile) els.imageFile.click();
});

els.imageFile.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const name = file.name;
  const blobUrl = URL.createObjectURL(file);
  mediaBlobUrls.push(blobUrl);
  mediaUrlMap.set(name, blobUrl);
  mediaUrlMap.set(`media/${name}`, blobUrl);
  mediaUrlMap.set(`./media/${name}`, blobUrl);

  const md = `\n\n![${name}](media/${name})\n\n`;
  insertAtCursor(els.editor, md);
  renderMarkdown(els.editor.value || "");
  event.target.value = "";
});

els.fullscreen.addEventListener("click", () => {
  if (!els.fullscreenOverlay) return;
  els.fullscreenOverlay.classList.add("active");
  els.fullscreenOverlay.setAttribute("aria-hidden", "false");
});

els.exitFullscreen.addEventListener("click", () => {
  if (!els.fullscreenOverlay) return;
  els.fullscreenOverlay.classList.remove("active");
  els.fullscreenOverlay.setAttribute("aria-hidden", "true");
});

loadConfig();
refreshButtons();
setStatus("Ready.");

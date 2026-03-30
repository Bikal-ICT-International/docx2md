const els = {
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

const WORKER_BASE = "https://docsconvert.bikstudy.workers.dev";
const lastDispatchKey = "docx-md-last-dispatch";
let mediaUrlMap = new Map();
let mediaBlobUrls = [];
let lastRenderedMarkdown = "";
let previewHeadingMap = [];
let fullscreenHeadingMap = [];
let syncRaf = null;
let fullscreenSyncRaf = null;
let previewSyncRaf = null;
let isSyncingFromPreview = false;
let isSyncingFromEditor = false;
const smoothScroll = true;
const smoothScrollThreshold = 240;
let pendingImageSync = false;

function setStatus(message) {
  const now = new Date().toLocaleTimeString();
  els.status.textContent = `[${now}] ${message}`;
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
  lastRenderedMarkdown = md;
  previewHeadingMap = buildHeadingMap(md, els.preview);
  if (els.fullscreenContent) {
    fullscreenHeadingMap = buildHeadingMap(md, els.fullscreenContent);
  }
  syncPreviewToEditor();
  wireImageLoadSync(els.preview, "preview");
  if (els.fullscreenContent) {
    wireImageLoadSync(els.fullscreenContent, "fullscreen");
  }
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

function extractMarkdownHeadings(md) {
  const lines = md.split(/\r?\n/);
  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const text = match[2].replace(/\s+/g, " ").trim();
    headings.push({ line: i, text });
  }
  return headings;
}

function buildHeadingMap(md, container) {
  if (!container) return [];
  const mdHeadings = extractMarkdownHeadings(md);
  const renderedHeadings = Array.from(
    container.querySelectorAll("h1, h2, h3, h4, h5, h6")
  );
  const count = Math.min(mdHeadings.length, renderedHeadings.length);
  const map = [];
  for (let i = 0; i < count; i += 1) {
    map.push({ line: mdHeadings[i].line, el: renderedHeadings[i] });
  }
  return map;
}

function getCurrentEditorLine() {
  const style = window.getComputedStyle(els.editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  return Math.max(0, Math.round(els.editor.scrollTop / lineHeight));
}

function syncPreviewToEditor() {
  if (isSyncingFromPreview) return;
  const activeFullscreen =
    els.fullscreenOverlay && els.fullscreenOverlay.classList.contains("active");
  const map = activeFullscreen ? fullscreenHeadingMap : previewHeadingMap;
  const container = activeFullscreen ? els.fullscreenContent : els.preview;
  if (!map.length || !container) return;

  const line = getCurrentEditorLine();
  let idx = 0;
  for (let i = 0; i < map.length; i += 1) {
    if (map[i].line <= line) {
      idx = i;
    } else {
      break;
    }
  }
  const target = map[idx].el;
  if (!target) return;
  const nextTop = Math.max(0, target.offsetTop - 8);
  const distance = Math.abs(container.scrollTop - nextTop);
  const shouldSmooth = smoothScroll && distance < smoothScrollThreshold;
  isSyncingFromEditor = true;
  if (shouldSmooth && typeof container.scrollTo === "function") {
    container.scrollTo({ top: nextTop, behavior: "smooth" });
  } else {
    container.scrollTop = nextTop;
  }
  window.setTimeout(() => {
    isSyncingFromEditor = false;
  }, 120);
}

function wireImageLoadSync(container, tag) {
  if (!container) return;
  const images = Array.from(container.querySelectorAll("img"));
  images.forEach((img) => {
    if (img.dataset.syncBound === tag) return;
    img.dataset.syncBound = tag;
    if (!img.complete) {
      img.addEventListener(
        "load",
        () => {
          if (pendingImageSync) return;
          pendingImageSync = true;
          window.requestAnimationFrame(() => {
            pendingImageSync = false;
            if (lastRenderedMarkdown) {
              previewHeadingMap = buildHeadingMap(lastRenderedMarkdown, els.preview);
              if (els.fullscreenContent) {
                fullscreenHeadingMap = buildHeadingMap(
                  lastRenderedMarkdown,
                  els.fullscreenContent
                );
              }
            }
            syncPreviewToEditor();
          });
        },
        { once: true }
      );
    }
  });
}

function getClosestHeadingIndex(map, scrollTop) {
  let idx = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < map.length; i += 1) {
    const distance = Math.abs(map[i].el.offsetTop - scrollTop);
    if (distance < best) {
      best = distance;
      idx = i;
    }
  }
  return idx;
}

function syncEditorToPreview(map, scrollTop) {
  if (!map.length) return;
  if (isSyncingFromEditor) return;
  const idx = getClosestHeadingIndex(map, scrollTop);
  const heading = map[idx];
  if (!heading) return;
  const style = window.getComputedStyle(els.editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const targetTop = Math.max(0, heading.line * lineHeight);
  const distance = Math.abs(els.editor.scrollTop - targetTop);
  const shouldSmooth = smoothScroll && distance < smoothScrollThreshold;
  isSyncingFromPreview = true;
  if (shouldSmooth && typeof els.editor.scrollTo === "function") {
    els.editor.scrollTo({ top: targetTop, behavior: "smooth" });
  } else {
    els.editor.scrollTop = targetTop;
  }
  window.setTimeout(() => {
    isSyncingFromPreview = false;
  }, 120);
}

function refreshButtons() {
  const ready = WORKER_BASE && WORKER_BASE.startsWith("http");
  els.upload.disabled = !ready || !els.file.files.length;
  els.download.disabled = !ready;
  els.check.disabled = !ready;
}

async function uploadDocx() {
  const file = els.file.files[0];
  if (!file) return;
  setStatus("Uploading...");

  const form = new FormData();
  form.append("file", file, file.name);

  const uploadRes = await fetch(`${WORKER_BASE}/upload`, {
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
  if (!uploadRes.ok) {
    throw new Error(
      (uploadJson && uploadJson.error) ||
        rawText ||
        "Upload failed. Check your Worker URL."
    );
  }
  if (!uploadJson || !uploadJson.ok) {
    throw new Error(
      (uploadJson && uploadJson.error) ||
        rawText ||
        "Upload failed. Invalid Worker response."
    );
  }

  localStorage.setItem(lastDispatchKey, String(Date.now()));
  setStatus("Upload complete. Conversion started.");
}

async function downloadLatestArtifact() {
  const lastDispatch = Number(localStorage.getItem(lastDispatchKey) || "0");
  setStatus("Finding latest completed run...");

  const dlRes = await fetch(`${WORKER_BASE}/artifact`);
  if (!dlRes.ok) {
    const text = await dlRes.text();
    setStatus(text || "Artifact not ready yet.");
    return;
  }
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
  a.download = "markdown-and-media.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("Download started and preview loaded.");
}

async function checkLatestRun() {
  const lastDispatch = Number(localStorage.getItem(lastDispatchKey) || "0");
  setStatus("Checking workflow status...");

  const res = await fetch(`${WORKER_BASE}/status`);
  if (!res.ok) {
    setStatus("No status available yet.");
    return;
  }
  const json = await res.json();
  const status = json.status || "unknown";
  const conclusion = json.conclusion || "pending";
  const ageNote = lastDispatch ? "" : " (no recent upload)";
  setStatus(`Latest run status: ${status} (${conclusion}).${ageNote}`);
}

els.file.addEventListener("change", refreshButtons);

els.upload.addEventListener("click", () => {
  uploadDocx().catch((err) => setStatus(err.message));
});

els.download.addEventListener("click", () => {
  downloadLatestArtifact().catch((err) => setStatus(err.message));
});

els.check.addEventListener("click", () => {
  checkLatestRun().catch((err) => setStatus(err.message));
});

refreshButtons();
setStatus("Ready.");

els.editor.addEventListener("input", (event) => {
  renderMarkdown(event.target.value || "");
});

els.editor.addEventListener("scroll", () => {
  if (syncRaf) return;
  syncRaf = window.requestAnimationFrame(() => {
    syncRaf = null;
    syncPreviewToEditor();
  });
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
  if (els.fullscreenContent) {
    els.fullscreenContent.innerHTML = els.preview.innerHTML;
    fullscreenHeadingMap = buildHeadingMap(
      lastRenderedMarkdown,
      els.fullscreenContent
    );
  }
  els.fullscreenOverlay.classList.add("active");
  els.fullscreenOverlay.setAttribute("aria-hidden", "false");
  syncPreviewToEditor();
});

els.exitFullscreen.addEventListener("click", () => {
  if (!els.fullscreenOverlay) return;
  els.fullscreenOverlay.classList.remove("active");
  els.fullscreenOverlay.setAttribute("aria-hidden", "true");
});

if (els.fullscreenContent) {
  els.fullscreenContent.addEventListener("scroll", () => {
    if (fullscreenSyncRaf) return;
    fullscreenSyncRaf = window.requestAnimationFrame(() => {
      fullscreenSyncRaf = null;
      syncEditorToPreview(
        fullscreenHeadingMap,
        els.fullscreenContent.scrollTop
      );
    });
  });
}

if (els.preview) {
  els.preview.addEventListener("scroll", () => {
    if (previewSyncRaf) return;
    previewSyncRaf = window.requestAnimationFrame(() => {
      previewSyncRaf = null;
      syncEditorToPreview(previewHeadingMap, els.preview.scrollTop);
    });
  });
}

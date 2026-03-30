const WORKER_BASE = "https://docx2md.bikstudy.workers.dev";


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

const lastDispatchKey = "docx-md-last-dispatch";
let mediaUrlMap = new Map();
let mediaBlobUrls = [];
let isSyncingScroll = false;

function setStatus(message) {
  const now = new Date().toLocaleTimeString();
  els.status.textContent = `[${now}] ${message}`;
}

function refreshButtons() {
  const ready = WORKER_BASE && WORKER_BASE.startsWith("http");
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
    if (els.preview) {
      els.preview.textContent = "Markdown renderer not loaded.";
    }
    return;
  }
  const rewritten = rewriteImageLinks(md);
  const html = window.marked.parse(rewritten);
  if (els.preview) {
    els.preview.innerHTML = html;
    const imgs = els.preview.querySelectorAll("img");
    imgs.forEach((img) => {
      const src = img.getAttribute("src") || "";
      const key = src.split(/[\\/]/).pop();
      const mapped =
        mediaUrlMap.get(src) || mediaUrlMap.get(key) || mediaUrlMap.get(decodeURIComponent(key));
      if (mapped) {
        img.src = mapped;
      }
    });
  }
  if (els.fullscreenContent) {
    els.fullscreenContent.innerHTML = html;
  }
}

function syncScroll(fromEl, toEl) {
  if (!fromEl || !toEl) return;
  if (isSyncingScroll) return;
  const fromMax = fromEl.scrollHeight - fromEl.clientHeight;
  const toMax = toEl.scrollHeight - toEl.clientHeight;
  if (fromMax <= 0 || toMax <= 0) return;
  const ratio = fromEl.scrollTop / fromMax;
  isSyncingScroll = true;
  toEl.scrollTop = ratio * toMax;
  requestAnimationFrame(() => {
    isSyncingScroll = false;
  });
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
    throw new Error((uploadJson && uploadJson.error) || rawText || "Upload failed");
  }
  if (!uploadJson || !uploadJson.ok) {
    throw new Error((uploadJson && uploadJson.error) || rawText || "Upload failed");
  }

  localStorage.setItem(lastDispatchKey, String(Date.now()));
  setStatus("Upload complete. Conversion started.");
}

async function downloadLatestArtifact() {
  setStatus("Fetching latest artifact...");
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
  setStatus("Checking workflow status...");
  const res = await fetch(`${WORKER_BASE}/status`);
  if (!res.ok) {
    setStatus("No status available yet.");
    return;
  }
  const json = await res.json();
  const status = json.status || "unknown";
  const conclusion = json.conclusion || "pending";
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

els.editor.addEventListener("input", (event) => {
  renderMarkdown(event.target.value || "");
});

els.editor.addEventListener("scroll", () => {
  syncScroll(els.editor, els.preview);
});

els.preview.addEventListener("scroll", () => {
  syncScroll(els.preview, els.editor);
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

refreshButtons();
setStatus("Ready.");



const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PAGE_SIZE = 24;

const state = {
  curated: [],
  community: [],
  cursor: null,
  truncated: false,
  filter: "all",
  items: [],
  nodes: new Map(),
  view: [],
  viewIndex: 0,
  maxBytes: 10 * 1024 * 1024,
  storageReady: true,
  submitting: false,
};

const els = {
  grid: $("#gallery-grid"),
  count: $("#galleryCount"),
  status: $("#galleryStatus"),
  empty: $("#galleryEmpty"),
  emptyText: $("#galleryEmptyText"),
  loadMore: $("#loadMore"),
  form: $("#uploadForm"),
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  queue: $("#queue"),
  uploader: $("#uploader"),
  caption: $("#caption"),
  submit: $("#submitBtn"),
  progress: $("#progress"),
  progressBar: $("#progressBar"),
  progressText: $("#progressText"),
  formStatus: $("#formStatus"),
  turnstile: $("#turnstile"),
  lightbox: $("#lightbox"),
  lightboxImage: $("#lightboxImage"),
  lightboxCaption: $("#lightboxCaption"),
  lightboxDownload: $("#lightboxDownload"),
  nav: $("#nav"),
  navToggle: $(".nav__toggle"),
  navPanel: $("#navPanel"),
};

const itemKey = (item) => `${item.source}:${item.id || item.key || item.file}`;

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function setStatus(message, tone) {
  if (!els.status) return;
  if (!message) {
    els.status.hidden = true;
    els.status.textContent = "";
    return;
  }
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.style.color = tone === "error" ? "#b3261e" : "";
}

function setGalleryCount() {
  if (!els.count) return;
  if (!state.items.length) {
    els.count.textContent = "还没有照片";
    return;
  }
  const suffix = state.truncated && state.filter !== "curated" ? "（可继续加载）" : "";
  els.count.textContent = `共 ${state.items.length} 张${suffix}`;
}

/* ---------------- 相册渲染 ---------------- */

function createNode(item) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "gallery__item";
  node.dataset.key = itemKey(item);
  node.setAttribute("aria-label", item.caption ? `查看照片：${item.caption}` : "查看照片");

  if (item.lqip) {
    node.style.backgroundImage = `url("${item.lqip}")`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
  }

  const img = document.createElement("img");
  img.alt = item.alt || item.caption || "无毛猴照片";
  img.decoding = "async";
  img.loading = "lazy";
  img.src = item.thumb || item.url || item.file;
  img.addEventListener("load", () => {
    node.classList.add("is-loaded");
    if (!item.width || !item.height) {
      item.width = img.naturalWidth;
      item.height = img.naturalHeight;
      scheduleLayout();
    }
  });
  img.addEventListener("error", () => {
    node.classList.add("is-loaded");
    node.style.background = "#e8e8ed";
  });

  const label = document.createElement("span");
  label.className = "gallery__label";
  const text = document.createElement("span");
  if (item.source === "community") {
    text.textContent = item.caption ? `${item.uploader}：${item.caption}` : `来自 ${item.uploader}`;
  } else {
    text.textContent = "精选";
  }
  label.append(text);

  node.append(img, label);
  node.addEventListener("click", () => openLightbox(item));
  return node;
}

function applyFilter() {
  const ordered = [...state.community, ...state.curated];
  state.items = ordered.filter((item) => state.filter === "all" || item.source === state.filter);
  state.items.forEach((item) => {
    const key = itemKey(item);
    if (!state.nodes.has(key)) state.nodes.set(key, createNode(item));
  });

  const fragment = document.createDocumentFragment();
  state.items.forEach((item) => fragment.append(state.nodes.get(itemKey(item))));
  els.grid.replaceChildren(fragment);

  const isEmpty = state.items.length === 0;
  els.empty.hidden = !isEmpty;
  if (isEmpty) {
    els.emptyText.textContent =
      state.filter === "community"
        ? "还没有人上传照片，你可以是第一个。"
        : "相册暂时是空的。";
  }

  els.loadMore.hidden = !(state.truncated && state.filter !== "curated");
  setGalleryCount();
  layout();
}

let layoutTimer = 0;
function scheduleLayout() {
  window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(layout, 90);
}

function layout() {
  const width = els.grid.clientWidth;
  if (!width || !state.items.length) return;

  const compact = width < 640;
  const gap = compact ? 8 : 12;
  const target = compact ? 188 : width < 1100 ? 256 : 316;
  els.grid.style.gap = `${gap}px`;

  const rows = [];
  let row = [];
  let ratioSum = 0;

  state.items.forEach((item) => {
    const ratio = item.width && item.height ? item.width / item.height : 1;
    row.push({ key: itemKey(item), ratio });
    ratioSum += ratio;
    const available = width - gap * (row.length - 1);
    if (ratioSum * target >= available) {
      rows.push({ row, ratioSum, available });
      row = [];
      ratioSum = 0;
    }
  });
  if (row.length) {
    rows.push({ row, ratioSum, available: width - gap * (row.length - 1), last: true });
  }

  rows.forEach((current) => {
    const stretch = !current.last || current.ratioSum * target >= current.available * 0.86;
    const height = stretch ? current.available / current.ratioSum : target;
    current.row.forEach((cell) => {
      const node = state.nodes.get(cell.key);
      if (!node) return;
      node.style.width = `${(cell.ratio * height).toFixed(3)}px`;
      node.style.height = `${height.toFixed(3)}px`;
    });
  });
}

/* ---------------- 数据 ---------------- */

async function loadCurated() {
  try {
    const res = await fetch("assets/data/curated.json", { cache: "force-cache" });
    if (!res.ok) return;
    const data = await res.json();
    state.curated = (data.items || []).map((item) => ({
      ...item,
      source: "curated",
      url: item.file,
      thumb: item.thumb || item.file,
    }));
    applyFilter();
  } catch {
    /* 精选照片缺失时静默处理 */
  }
}

async function loadCommunity({ reset = false } = {}) {
  if (reset) {
    state.cursor = null;
    state.truncated = false;
  }

  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (state.cursor) params.set("cursor", state.cursor);

  try {
    const res = await fetch(`/api/photos?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const incoming = (data.items || []).map((item) => ({
      ...item,
      source: "community",
      thumb: item.url,
    }));

    const map = new Map(state.community.map((item) => [itemKey(item), item]));
    incoming.forEach((item) => {
      if (reset) {
        state.nodes.delete(itemKey(item));
        map.delete(itemKey(item));
      }
      map.set(itemKey(item), item);
    });

    state.community = Array.from(map.values()).sort((a, b) =>
      String(b.uploaded || "").localeCompare(String(a.uploaded || "")),
    );
    state.cursor = data.cursor || null;
    state.truncated = Boolean(data.truncated);
    state.storageReady = data.storageReady !== false;
    if (state.storageReady) setStatus("");
    else setStatus("照片存储还没配置好，暂时无法上传和保存。", "error");
    applyFilter();
  } catch {
    setStatus("云端相册暂时连不上，先看看精选照片。", "error");
    applyFilter();
  }
}

/* ---------------- 灯箱 ---------------- */

function openLightbox(item) {
  state.view = state.items.slice();
  state.viewIndex = Math.max(
    0,
    state.view.findIndex((candidate) => itemKey(candidate) === itemKey(item)),
  );
  els.lightbox.hidden = false;
  document.body.style.overflow = "hidden";
  renderLightbox();
  els.lightbox.focus?.();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  document.body.style.overflow = "";
  els.lightboxImage.removeAttribute("src");
}

function stepLightbox(delta) {
  if (!state.view.length) return;
  state.viewIndex = (state.viewIndex + delta + state.view.length) % state.view.length;
  renderLightbox();
}

function renderLightbox() {
  const item = state.view[state.viewIndex];
  if (!item) return;

  const full = item.full || item.url || item.file;
  els.lightboxImage.src = full;
  els.lightboxImage.alt = item.caption || "无毛猴照片";
  els.lightboxCaption.textContent =
    item.source === "community"
      ? [item.uploader, formatDate(item.uploaded), item.caption].filter(Boolean).join(" · ")
      : "精选照片";

  if (item.source === "community") {
    els.lightboxDownload.href = `${item.url}${item.url.includes("?") ? "&" : "?"}download=1`;
  } else {
    els.lightboxDownload.href = item.file;
  }

  const single = state.view.length < 2;
  $("#lightboxPrev").hidden = single;
  $("#lightboxNext").hidden = single;
}

/* ---------------- 上传 ---------------- */

const queue = [];

function renderQueue() {
  els.queue.hidden = queue.length === 0;
  els.queue.replaceChildren(
    ...queue.map((entry) => {
      const li = document.createElement("li");
      li.className = "queue__item";
      if (entry.status === "done") li.classList.add("is-done");
      if (entry.status === "error") li.classList.add("is-error");

      const thumb = document.createElement("div");
      thumb.className = "queue__thumb";
      const img = document.createElement("img");
      img.src = entry.preview;
      img.alt = "";
      thumb.append(img);

      const info = document.createElement("div");
      info.className = "queue__info";
      const name = document.createElement("span");
      name.className = "queue__name";
      name.textContent = entry.name;
      const meta = document.createElement("span");
      meta.className = "queue__size";
      meta.textContent =
        entry.status === "done"
          ? `已上传 · ${formatSize(entry.blob.size)}`
          : entry.status === "error"
            ? entry.error || "上传失败"
            : `${entry.status === "uploading" ? "上传中 · " : ""}${formatSize(entry.blob.size)}`;
      info.append(name, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queue__remove";
      remove.setAttribute("aria-label", "移除");
      remove.innerHTML =
        '<svg class="icon" aria-hidden="true"><use href="#i-close"></use></svg>';
      remove.disabled = entry.status === "uploading";
      remove.addEventListener("click", () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        URL.revokeObjectURL(entry.preview);
        renderQueue();
        syncSubmit();
      });

      li.append(thumb, info, remove);
      return li;
    }),
  );
  syncSubmit();
}

function syncSubmit() {
  const pending = queue.filter((entry) => entry.status === "ready");
  els.submit.disabled = state.submitting || pending.length === 0 || !state.storageReady;
  els.submit.textContent = "";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-upload");
  icon.append(use);
  const label = document.createTextNode(queue.length > 1 ? `上传 ${queue.length} 张` : "上传");
  els.submit.append(icon, label);
}

function setFormStatus(message, tone) {
  els.formStatus.hidden = !message;
  els.formStatus.textContent = message || "";
  els.formStatus.classList.toggle("is-ok", tone === "ok");
  els.formStatus.classList.toggle("is-error", tone === "error");
}

async function prepareImage(file) {
  const original = { blob: file, width: 0, height: 0 };
  if (!/^image\//.test(file.type)) throw new Error("不是图片文件");
  if (file.type === "image/gif") return original;
  if (typeof createImageBitmap !== "function") return original;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return original;
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const maxEdge = 2400;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));

  // 小体积 PNG 保留透明通道，其余统一重编码，顺便抹掉 EXIF 信息。
  if (scale === 1 && file.type === "image/png" && file.size < 1.5 * 1024 * 1024) {
    bitmap.close?.();
    return { blob: file, width: sourceWidth, height: sourceHeight };
  }

  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) return original;
  return { blob, width, height };
}

async function addFiles(files) {
  const list = Array.from(files).slice(0, 12);
  if (!list.length) return;

  setFormStatus("");
  for (const file of list) {
    const entry = {
      name: file.name,
      blob: file,
      preview: URL.createObjectURL(file),
      status: "ready",
    };
    queue.push(entry);
    renderQueue();

    if (file.size > 40 * 1024 * 1024) {
      entry.status = "error";
      entry.error = "文件超过 40 MB";
      renderQueue();
      continue;
    }

    try {
      const prepared = await prepareImage(file);
      if (prepared.blob.size > state.maxBytes) {
        entry.status = "error";
        entry.error = "压缩后仍然超过 10 MB";
      } else {
        entry.blob = prepared.blob;
        entry.width = prepared.width;
        entry.height = prepared.height;
      }
    } catch (error) {
      entry.status = "error";
      entry.error = error.message;
    }
    renderQueue();
  }
}

function uploadEntry(entry, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    const isJpeg = entry.blob.type === "image/jpeg" || /\.jpe?g$/i.test(entry.name);
    const name = entry.name.replace(/\.[^.]+$/, "") + (isJpeg ? ".jpg" : "");
    form.append("photo", entry.blob, name || "photo.jpg");
    form.append("uploader", meta.uploader);
    form.append("caption", meta.caption);
    form.append("width", String(entry.width || 0));
    form.append("height", String(entry.height || 0));
    if (meta.turnstileToken) form.append("cf-turnstile-response", meta.turnstileToken);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("服务器返回异常"));
        }
      } else {
        let message = "上传失败，请稍后重试";
        try {
          const data = JSON.parse(xhr.responseText);
          message =
            {
              too_large: "照片太大",
              unsupported_type: "不支持的图片格式",
              verification_failed: "人机校验未通过，请刷新页面重试",
              storage_not_configured: "服务器还没配置照片存储",
              bad_request: "请求格式不对",
            }[data.error] || message;
        } catch {
          /* 保留默认提示 */
        }
        reject(new Error(message));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("网络异常，请检查网络后重试")));
    xhr.send(form);
  });
}

async function submitUploads(event) {
  event.preventDefault();
  const pending = queue.filter((entry) => entry.status === "ready");
  if (!pending.length) return;

  const meta = {
    uploader: els.uploader.value.trim(),
    caption: els.caption.value.trim(),
    turnstileToken: getTurnstileToken(),
  };
  if (meta.uploader) window.localStorage.setItem("hm:uploader", meta.uploader);

  els.submit.disabled = true;
  state.submitting = true;
  els.progress.hidden = false;
  setFormStatus("");

  let done = 0;
  let failed = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    entry.status = "uploading";
    renderQueue();
    try {
      await uploadEntry(entry, meta, (ratio) => {
        const overall = (index + ratio) / pending.length;
        els.progressBar.style.width = `${Math.round(overall * 100)}%`;
        els.progressText.textContent = `${Math.round(overall * 100)}%`;
      });
      entry.status = "done";
      done += 1;
    } catch (error) {
      entry.status = "error";
      entry.error = error.message;
      failed += 1;
    }
    renderQueue();
  }

  els.progress.hidden = true;
  els.progressBar.style.width = "0%";
  state.submitting = false;
  resetTurnstile();

  if (done) {
    await loadCommunity({ reset: true });
    setFormStatus(failed ? `${done} 张已上传，${failed} 张失败。` : `${done} 张已上传，已经出现在相册里。`, failed ? "error" : "ok");
    queue
      .filter((entry) => entry.status === "done")
      .forEach((entry) => URL.revokeObjectURL(entry.preview));
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].status === "done") queue.splice(index, 1);
    }
    renderQueue();
    $("#gallery").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  } else {
    setFormStatus("这次没有上传成功，换一张再试试。", "error");
  }
}

/* ---------------- Turnstile（可选） ---------------- */

let turnstileWidget = null;

function renderTurnstile(siteKey) {
  els.turnstile.hidden = false;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.addEventListener("load", () => {
    if (!window.turnstile) return;
    turnstileWidget = window.turnstile.render(els.turnstile, {
      sitekey: siteKey,
      theme: "light",
      action: "upload",
    });
  });
  document.head.append(script);
}

function getTurnstileToken() {
  if (turnstileWidget === null || !window.turnstile) return "";
  return window.turnstile.getResponse(turnstileWidget) || "";
}

function resetTurnstile() {
  if (turnstileWidget !== null && window.turnstile) window.turnstile.reset(turnstileWidget);
}

/* ---------------- 页面交互 ---------------- */

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function initReveal() {
  const targets = $$(".reveal");
  if (!targets.length || !("IntersectionObserver" in window)) {
    targets.forEach((target) => target.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  targets.forEach((target) => observer.observe(target));
}

function initNav() {
  els.navToggle?.addEventListener("click", () => {
    const open = els.navToggle.getAttribute("aria-expanded") === "true";
    els.navToggle.setAttribute("aria-expanded", String(!open));
    els.navPanel.hidden = open;
  });
  $$("a", els.navPanel).forEach((link) =>
    link.addEventListener("click", () => {
      els.navToggle.setAttribute("aria-expanded", "false");
      els.navPanel.hidden = true;
    }),
  );
}

function initLightbox() {
  $("#lightboxClose").addEventListener("click", closeLightbox);
  $("#lightboxPrev").addEventListener("click", () => stepLightbox(-1));
  $("#lightboxNext").addEventListener("click", () => stepLightbox(1));
  els.lightbox.addEventListener("click", (event) => {
    if (event.target === els.lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (els.lightbox.hidden) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") stepLightbox(-1);
    if (event.key === "ArrowRight") stepLightbox(1);
  });
}

function initSegments() {
  $$(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      $$(".segmented button").forEach((other) =>
        other.setAttribute("aria-selected", String(other === button)),
      );
      applyFilter();
    });
  });
}

function initUpload() {
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) =>
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("is-over");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("is-over");
    }),
  );
  els.dropzone.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });

  window.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) {
      document.getElementById("upload").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
      addFiles(files);
    }
  });

  els.form.addEventListener("submit", submitUploads);
  els.uploader.value = window.localStorage.getItem("hm:uploader") || "";
  syncSubmit();
}

async function initConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    state.maxBytes = config.maxBytes || state.maxBytes;
    state.storageReady = config.storageReady !== false;
    if (config.storageReady === false) {
      setStatus("照片存储还没配置好，暂时无法上传和保存。", "error");
    }
    syncSubmit();
    if (config.turnstileSiteKey) renderTurnstile(config.turnstileSiteKey);
  } catch {
    /* 本地预览时接口不存在，忽略即可 */
  }
}

function init() {
  $("#year").textContent = String(new Date().getFullYear());
  initReveal();
  initNav();
  initLightbox();
  initSegments();
  initUpload();

  window.addEventListener("resize", scheduleLayout);
  if ("ResizeObserver" in window) new ResizeObserver(scheduleLayout).observe(els.grid);

  els.loadMore.addEventListener("click", () => loadCommunity());

  // 直接双击 index.html（file://）时样式和图能显示，但相册、上传都要走服务端接口。
  if (window.location.protocol === "file:") {
    state.storageReady = false;
    setStatus(
      "现在是用本地文件方式打开的（file://），相册和上传读不到数据。请在项目目录执行 npm run dev，然后访问 http://127.0.0.1:8787",
      "error",
    );
    syncSubmit();
    return;
  }

  initConfig();
  loadCurated();
  loadCommunity();
}

init();

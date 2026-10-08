const $ = (selector, root = document) => root.querySelector(selector);

const state = { token: "", cursor: null, items: [], truncated: false };

const els = {
  form: $("#tokenForm"),
  token: $("#tokenInput"),
  status: $("#status"),
  count: $("#count"),
  list: $("#list"),
  loadMore: $("#loadMore"),
};

function setStatus(message, tone) {
  els.status.hidden = !message;
  els.status.textContent = message || "";
  els.status.classList.toggle("is-ok", tone === "ok");
  els.status.classList.toggle("is-error", tone === "error");
}

function formatSize(bytes) {
  if (!bytes) return "";
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function render() {
  els.count.textContent = `共 ${state.items.length} 张`;
  els.loadMore.hidden = !state.truncated;
  els.list.replaceChildren(
    ...state.items.map((item) => {
      const li = document.createElement("li");
      li.className = "manage__item";

      const thumb = document.createElement("img");
      thumb.src = item.url;
      thumb.alt = item.caption || "无毛猴照片";
      thumb.loading = "lazy";

      const info = document.createElement("div");
      info.className = "manage__info";
      const title = document.createElement("strong");
      title.textContent = item.caption || "（没有说明）";
      const meta = document.createElement("span");
      meta.textContent = [item.uploader, formatDate(item.uploaded), formatSize(item.size)]
        .filter(Boolean)
        .join(" · ");
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "manage__actions";
      const view = document.createElement("a");
      view.className = "btn btn--ghost btn--small";
      view.href = item.url;
      view.target = "_blank";
      view.rel = "noopener";
      view.textContent = "查看";
      const remove = document.createElement("button");
      remove.className = "btn btn--small";
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeItem(item, remove));
      actions.append(view, remove);

      li.append(thumb, info, actions);
      return li;
    }),
  );
}

async function loadPage({ reset = false } = {}) {
  if (!state.token) {
    setStatus("请先填写管理口令。", "error");
    return;
  }
  if (reset) {
    state.cursor = null;
    state.items = [];
  }

  const params = new URLSearchParams({ limit: "30" });
  if (state.cursor) params.set("cursor", state.cursor);
  setStatus("正在加载…");

  try {
    const res = await fetch(`/api/photos?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const seen = new Set(state.items.map((item) => item.key));
    (data.items || []).forEach((item) => {
      if (!seen.has(item.key)) state.items.push(item);
    });
    state.cursor = data.cursor || null;
    state.truncated = Boolean(data.truncated);
    render();
    setStatus(data.storageReady === false ? "照片存储还没配置好。" : "", data.storageReady === false ? "error" : undefined);
  } catch (error) {
    setStatus(`加载失败：${error.message}`, "error");
  }
}

async function removeItem(item, button) {
  if (!window.confirm(`确定删除「${item.caption || item.key}」？此操作不可撤销。`)) return;
  button.disabled = true;
  try {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.token, key: item.key }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        { unauthorized: "口令不正确", admin_disabled: "服务端还没有设置 ADMIN_TOKEN" }[data.error] ||
          data.error ||
          `HTTP ${res.status}`,
      );
    }
    state.items = state.items.filter((entry) => entry.key !== item.key);
    render();
    setStatus("已删除。", "ok");
  } catch (error) {
    button.disabled = false;
    setStatus(`删除失败：${error.message}`, "error");
  }
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.token = els.token.value.trim();
  if (state.token) window.localStorage.setItem("hm:token", state.token);
  else window.localStorage.removeItem("hm:token");
  loadPage({ reset: true });
});

els.loadMore.addEventListener("click", () => loadPage());

state.token = window.localStorage.getItem("hm:token") || "";
els.token.value = state.token;

if (window.location.protocol === "file:") {
  setStatus(
    "管理页要通过服务端访问：在项目目录执行 npm run dev，再打开 http://127.0.0.1:8787/manage.html",
    "error",
  );
} else if (state.token) {
  loadPage({ reset: true });
}

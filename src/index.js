/**
 * 无毛猴站点后端（Cloudflare Worker）
 *
 * 路由：
 *   GET  /api/config            前端启动配置（上传体积上限、Turnstile 公钥、存储类型）
 *   GET  /api/photos?cursor&limit  云端相册列表（按上传时间倒序，游标分页）
 *   POST /api/upload            上传照片（multipart/form-data）
 *   POST /api/delete            删除照片（需要 ADMIN_TOKEN）
 *   GET  /api/image/<key>       读取照片（可加 ?download=1）
 *
 * 存储层在 src/storage.js：绑定了 R2 就用 R2，配了 B2_* 就用 Backblaze B2，二选一。
 *
 * 对象键：photos/<倒序毫秒时间戳>-<随机串>.<ext>。
 * R2 的 list 按键名字典序升序返回，reverse 选项各运行时不保证一致，
 * 所以把时间戳倒过来写：字典序升序 == 上传时间倒序，翻页也不会乱。
 */

import { createStorage } from "./storage.js";

const MAX_BYTES = 10 * 1024 * 1024;
const KEY_RE = /^photos\/[0-9]{13}-[a-z0-9]{4,12}\.(jpg|png|webp|gif|avif)$/;
const ID_BASE = 9999999999999;

const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(parsed, min), max);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const stripped = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(stripped).slice(0, maxLength).join("");
}

/** 通过文件头判断真实类型，不信任客户端声明的 MIME。 */
function sniffType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  if (/ftyp(avif|avis|mif1|heic|heix|msf1)/.test(brand)) return "image/avif";
  return null;
}

function makeId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  let suffix = "";
  for (const byte of random) suffix += alphabet[byte % alphabet.length];
  const inverted = String(ID_BASE - Date.now()).padStart(13, "0");
  return `${inverted}-${suffix}`;
}

function toItem(entry) {
  const meta = entry.metadata || {};
  return {
    id: entry.key.replace(/^photos\//, "").replace(/\.[^.]+$/, ""),
    key: entry.key,
    url: `/api/image/${entry.key}`,
    uploader: meta.uploader || "匿名",
    caption: meta.caption || "",
    uploaded: meta.uploaded || entry.uploaded || "",
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    size: entry.size || 0,
    type: entry.contentType || "",
    source: "community",
  };
}

function imageHeaders(entry, { download = false } = {}) {
  const headers = new Headers();
  headers.set("content-type", entry.contentType || "application/octet-stream");
  headers.set("cache-control", IMMUTABLE);
  if (entry.etag) headers.set("etag", entry.etag);
  if (entry.size) headers.set("content-length", String(entry.size));
  headers.set("content-disposition", `${download ? "attachment" : "inline"}; filename="hairless-monkey.${fileExt(entry.key)}"`);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function fileExt(key) {
  return (String(key).split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "");
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}

async function handleUpload(request, env) {
  const storage = createStorage(env);
  if (!storage) return json({ error: "storage_not_configured" }, { status: 503 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad_request" }, { status: 400 });
  }

  const file = form.get("photo");
  if (!file || typeof file === "string") return json({ error: "missing_file" }, { status: 400 });
  if (file.size <= 0) return json({ error: "empty_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return json({ error: "too_large", maxBytes: MAX_BYTES }, { status: 413 });

  const buffer = await file.arrayBuffer();
  const type = sniffType(new Uint8Array(buffer.slice(0, 16)));
  if (!type) return json({ error: "unsupported_type" }, { status: 415 });

  const human = await verifyTurnstile(request, env, form.get("cf-turnstile-response"));
  if (!human) return json({ error: "verification_failed" }, { status: 403 });

  const key = `photos/${makeId()}.${TYPES[type]}`;
  const metadata = {
    uploader: cleanText(form.get("uploader"), 24) || "匿名",
    caption: cleanText(form.get("caption"), 140),
    uploaded: new Date().toISOString(),
    width: String(clampInt(form.get("width"), 0, 30000)),
    height: String(clampInt(form.get("height"), 0, 30000)),
  };

  try {
    await storage.put(key, buffer, { contentType: type, cacheControl: IMMUTABLE, metadata });
  } catch (error) {
    console.error("upload failed", error);
    return json({ error: "storage_unavailable", detail: String(error?.message || error) }, { status: 502 });
  }

  return json(
    {
      item: toItem({
        key,
        size: buffer.byteLength,
        uploaded: metadata.uploaded,
        contentType: type,
        metadata,
      }),
      storage: storage.kind,
    },
    { status: 201 },
  );
}

async function handleList(url, env) {
  const storage = createStorage(env);
  if (!storage) {
    return json({ items: [], cursor: null, truncated: false, storageReady: false, storage: null });
  }

  const limit = clampInt(url.searchParams.get("limit"), 1, 60) || 24;
  const cursor = url.searchParams.get("cursor") || undefined;

  let listed;
  try {
    listed = await storage.list({ limit, cursor });
  } catch (error) {
    console.error("list failed", error);
    return json({ error: "storage_unavailable", detail: String(error?.message || error) }, { status: 502 });
  }

  return json({
    items: listed.items.map(toItem),
    cursor: listed.cursor,
    truncated: listed.truncated,
    storageReady: true,
    storage: storage.kind,
  });
}

async function handleImage(request, env, key, url) {
  const storage = createStorage(env);
  if (!storage) return new Response("Not Found", { status: 404 });
  if (!KEY_RE.test(key)) return new Response("Bad Request", { status: 400 });

  const download = url.searchParams.get("download") === "1";

  try {
    if (request.method === "HEAD") {
      const head = await storage.head(key);
      if (!head) return new Response(null, { status: 404 });
      return new Response(null, { headers: imageHeaders({ ...head, key }, { download }) });
    }

    const entry = await storage.get(key);
    if (!entry) return new Response("Not Found", { status: 404 });

    if (entry.etag && request.headers.get("if-none-match")?.includes(entry.etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag: entry.etag, "cache-control": IMMUTABLE },
      });
    }

    return new Response(entry.body, { headers: imageHeaders({ ...entry, key }, { download }) });
  } catch (error) {
    // 存储端取不到图（网络不通、配额、区域问题等）时明确返回 502，而不是 500 崩掉
    console.error("image proxy failed", key, error);
    return new Response("照片存储暂时取不到这张图", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleDelete(request, env) {
  const storage = createStorage(env);
  if (!storage) return json({ error: "storage_not_configured" }, { status: 503 });
  if (!env.ADMIN_TOKEN) return json({ error: "admin_disabled" }, { status: 503 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad_request" }, { status: 400 });
  }

  const token = cleanText(payload?.token, 200);
  if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, { status: 401 });

  const keys = Array.isArray(payload?.keys) ? payload.keys : [payload?.key];
  const valid = keys.filter((key) => typeof key === "string" && KEY_RE.test(key)).slice(0, 50);
  if (valid.length === 0) return json({ error: "bad_key" }, { status: 400 });

  try {
    await storage.deleteMany(valid);
  } catch (error) {
    console.error("delete failed", error);
    return json({ error: "storage_unavailable", detail: String(error?.message || error) }, { status: 502 });
  }
  return json({ deleted: valid });
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    const storage = createStorage(env);
    return json({
      maxBytes: MAX_BYTES,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      storageReady: Boolean(storage),
      storage: storage?.kind || null,
      adminEnabled: Boolean(env.ADMIN_TOKEN),
    });
  }

  if (path === "/api/photos" && request.method === "GET") return handleList(url, env);
  if (path === "/api/upload" && request.method === "POST") return handleUpload(request, env);
  if (path === "/api/delete" && request.method === "POST") return handleDelete(request, env);

  if (path.startsWith("/api/image/") && (request.method === "GET" || request.method === "HEAD")) {
    return handleImage(request, env, decodeURIComponent(path.slice("/api/image/".length)), url);
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
      if (response.status === 404 && request.method === "GET" && wantsHtml) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
      }
      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
};

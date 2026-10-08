/**
 * 无毛猴站点后端（Cloudflare Worker）
 *
 * 路由：
 *   GET  /api/config            前端启动配置（上传体积上限、Turnstile 公钥）
 *   GET  /api/photos?cursor&limit  云端相册列表（按上传时间倒序，游标分页）
 *   POST /api/upload            上传照片（multipart/form-data）
 *   POST /api/delete            删除照片（需要 ADMIN_TOKEN）
 *   GET  /api/image/<key>       读取照片（可加 ?download=1）
 *
 * 存储：R2 单 bucket。对象键 photos/<倒序毫秒时间戳>-<随机串>.<ext>，
 * 上传者昵称、说明、尺寸写在对象自定义元数据里，列表接口一次 list 即可拿到。
 */

const MAX_BYTES = 10 * 1024 * 1024;
const KEY_RE = /^photos\/[0-9]{13}-[a-z0-9]{4,12}\.(jpg|png|webp|gif|avif)$/;
// R2 的 list 是按键名字典序升序返回的，reverse 选项各运行时不保证一致，
// 所以把时间戳倒过来写进键名：字典序升序 == 上传时间倒序，翻页也不会乱。
const ID_BASE = 9999999999999;

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, min), max);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const stripped = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(stripped).slice(0, maxLength).join('');
}

/** 通过文件头判断真实类型，避免只信任客户端声明的 MIME。 */
function sniffType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  if (/ftyp(avif|avis|mif1|heic|heix|msf1)/.test(brand)) return 'image/avif';
  return null;
}

function makeId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  let suffix = '';
  for (const byte of random) suffix += alphabet[byte % alphabet.length];
  const inverted = String(ID_BASE - Date.now()).padStart(13, '0');
  return `${inverted}-${suffix}`;
}

function toItem(object) {
  const meta = object.customMetadata || {};
  const http = object.httpMetadata || {};
  return {
    id: object.key.replace(/^photos\//, '').replace(/\.[^.]+$/, ''),
    key: object.key,
    url: `/api/image/${object.key}`,
    uploader: meta.uploader || '匿名',
    caption: meta.caption || '',
    uploaded: meta.uploaded || (object.uploaded ? new Date(object.uploaded).toISOString() : ''),
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    size: object.size || 0,
    type: http.contentType || '',
    source: 'community',
  };
}

function imageHeaders(object, { download = false, etag } = {}) {
  const http = object.httpMetadata || {};
  const headers = new Headers();
  headers.set('content-type', http.contentType || 'application/octet-stream');
  headers.set('cache-control', IMMUTABLE);
  if (etag || object.httpEtag) headers.set('etag', etag || object.httpEtag);
  if (object.size) headers.set('content-length', String(object.size));
  const disposition = download ? 'attachment' : 'inline';
  const ext = (object.key.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '');
  headers.set('content-disposition', `${disposition}; filename="hairless-monkey.${ext}"`);
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

async function handleUpload(request, env) {
  if (!env.PHOTO_BUCKET) return json({ error: 'storage_not_configured' }, { status: 503 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const file = form.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'missing_file' }, { status: 400 });
  if (file.size <= 0) return json({ error: 'empty_file' }, { status: 400 });
  if (file.size > MAX_BYTES) return json({ error: 'too_large', maxBytes: MAX_BYTES }, { status: 413 });

  const buffer = await file.arrayBuffer();
  const type = sniffType(new Uint8Array(buffer.slice(0, 16)));
  if (!type) return json({ error: 'unsupported_type' }, { status: 415 });

  const okHuman = await verifyTurnstile(request, env, form.get('cf-turnstile-response'));
  if (!okHuman) return json({ error: 'verification_failed' }, { status: 403 });

  const key = `photos/${makeId()}.${TYPES[type]}`;
  const customMetadata = {
    uploader: cleanText(form.get('uploader'), 24) || '匿名',
    caption: cleanText(form.get('caption'), 140),
    uploaded: new Date().toISOString(),
    width: String(clampInt(form.get('width'), 0, 30000)),
    height: String(clampInt(form.get('height'), 0, 30000)),
  };

  await env.PHOTO_BUCKET.put(key, buffer, {
    httpMetadata: { contentType: type, cacheControl: IMMUTABLE },
    customMetadata,
  });

  return json(
    {
      item: {
        id: key.replace(/^photos\//, '').replace(/\.[^.]+$/, ''),
        key,
        url: `/api/image/${key}`,
        uploader: customMetadata.uploader,
        caption: customMetadata.caption,
        uploaded: customMetadata.uploaded,
        width: Number(customMetadata.width),
        height: Number(customMetadata.height),
        size: buffer.byteLength,
        type,
        source: 'community',
      },
    },
    { status: 201 },
  );
}

async function handleList(url, env) {
  if (!env.PHOTO_BUCKET) {
    return json({ items: [], cursor: null, truncated: false, storageReady: false });
  }

  const limit = clampInt(url.searchParams.get('limit'), 1, 60) || 24;
  const cursor = url.searchParams.get('cursor') || undefined;
  const listed = await env.PHOTO_BUCKET.list({
    prefix: 'photos/',
    limit,
    cursor,
    include: ['httpMetadata', 'customMetadata'],
  });

  const items = listed.objects.map(toItem).sort((a, b) => {
    const byTime = (b.uploaded || '').localeCompare(a.uploaded || '');
    return byTime !== 0 ? byTime : b.key.localeCompare(a.key);
  });

  return json({
    items,
    cursor: listed.truncated ? listed.cursor : null,
    truncated: Boolean(listed.truncated),
    storageReady: true,
  });
}

async function handleImage(request, env, key, url) {
  if (!env.PHOTO_BUCKET) return new Response('Not Found', { status: 404 });
  if (!KEY_RE.test(key)) return new Response('Bad Request', { status: 400 });

  const download = url.searchParams.get('download') === '1';

  if (request.method === 'HEAD') {
    const head = await env.PHOTO_BUCKET.head(key);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, { headers: imageHeaders(head, { download }) });
  }

  const object = await env.PHOTO_BUCKET.get(key);
  if (!object) return new Response('Not Found', { status: 404 });

  const etag = object.httpEtag;
  if (etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': IMMUTABLE } });
  }

  return new Response(object.body, { headers: imageHeaders(object, { download, etag }) });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleDelete(request, env) {
  if (!env.PHOTO_BUCKET) return json({ error: 'storage_not_configured' }, { status: 503 });
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, { status: 503 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const token = cleanText(payload?.token, 200);
  if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, { status: 401 });

  const keys = Array.isArray(payload?.keys) ? payload.keys : [payload?.key];
  const valid = keys.filter((key) => typeof key === 'string' && KEY_RE.test(key)).slice(0, 50);
  if (valid.length === 0) return json({ error: 'bad_key' }, { status: 400 });

  await env.PHOTO_BUCKET.delete(valid);
  return json({ deleted: valid });
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/config' && request.method === 'GET') {
    return json({
      maxBytes: MAX_BYTES,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      storageReady: Boolean(env.PHOTO_BUCKET),
      adminEnabled: Boolean(env.ADMIN_TOKEN),
    });
  }

  if (path === '/api/photos' && request.method === 'GET') return handleList(url, env);
  if (path === '/api/upload' && request.method === 'POST') return handleUpload(request, env);
  if (path === '/api/delete' && request.method === 'POST') return handleDelete(request, env);

  if (path.startsWith('/api/image/') && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleImage(request, env, decodeURIComponent(path.slice('/api/image/'.length)), url);
  }

  return json({ error: 'not_found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
      if (response.status === 404 && request.method === 'GET' && wantsHtml) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      }
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * 照片存储层：Backblaze B2 或 Cloudflare R2，对外接口完全一致。
 *
 * - 绑定了 R2（PHOTO_BUCKET）就用 R2；
 * - 配了 B2_KEY_ID / B2_APP_KEY / B2_BUCKET 就用 Backblaze B2；
 * - 都没配返回 null，页面上会提示「照片存储还没配置好」。
 *
 * B2 走的是官方原生 API（不是 S3 兼容接口）：原生接口支持账号级 master key，
 * 而且列表时会把自定义元数据（上传者、说明、尺寸）一起返回，不需要再逐张取头部。
 */

export const PHOTO_PREFIX = "photos/";

const B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
/** 桶名不是密钥，给个默认值，省得在仪表盘里再配一个变量；环境变量 B2_BUCKET 优先级更高。 */
const DEFAULT_B2_BUCKET = "herclus";
const AUTH_TTL = 12 * 60 * 60 * 1000;
const UPLOAD_TTL = 60 * 60 * 1000;

/** 同一个 isolate 里复用授权，避免每个请求都去换 token。 */
let cachedAuth = null;
let cachedUpload = null;

export function createStorage(env) {
  if (env.PHOTO_BUCKET) return new R2Storage(env.PHOTO_BUCKET);
  if (env.B2_KEY_ID && env.B2_APP_KEY) return new B2Storage(env);
  return null;
}

/* ------------------------------- Cloudflare R2 ------------------------------- */

class R2Storage {
  constructor(bucket) {
    this.bucket = bucket;
    this.kind = "r2";
  }

  async list({ limit = 24, cursor } = {}) {
    const listed = await this.bucket.list({
      prefix: PHOTO_PREFIX,
      limit,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });

    const items = listed.objects.map((object) => ({
      key: object.key,
      size: object.size || 0,
      uploaded: object.customMetadata?.uploaded || new Date(object.uploaded || Date.now()).toISOString(),
      contentType: object.httpMetadata?.contentType || "",
      etag: object.httpEtag || "",
      metadata: object.customMetadata || {},
    }));

    items.sort((a, b) => a.key.localeCompare(b.key));
    return {
      items,
      cursor: listed.truncated ? listed.cursor : null,
      truncated: Boolean(listed.truncated),
    };
  }

  async put(key, body, { contentType, cacheControl, metadata = {} }) {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType, cacheControl },
      customMetadata: metadata,
    });
  }

  async get(key) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      size: object.size || 0,
      uploaded: object.customMetadata?.uploaded || "",
      contentType: object.httpMetadata?.contentType || "application/octet-stream",
      etag: object.httpEtag || "",
      metadata: object.customMetadata || {},
    };
  }

  async head(key) {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      size: object.size || 0,
      uploaded: object.customMetadata?.uploaded || "",
      contentType: object.httpMetadata?.contentType || "application/octet-stream",
      etag: object.httpEtag || "",
      metadata: object.customMetadata || {},
    };
  }

  async deleteMany(keys) {
    await this.bucket.delete(keys.slice(0, 50));
  }
}

/* ------------------------------ Backblaze B2 ------------------------------ */

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

async function sha1Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** B2 的自定义元数据走 X-Bz-Info-* 头，值经过 URL 编码。 */
function fileInfoFromHeaders(headers, prefix = "x-bz-info-") {
  const info = {};
  headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith(prefix)) return;
    const key = name.slice(prefix.length).toLowerCase();
    try {
      info[key] = decodeURIComponent(value);
    } catch {
      info[key] = value;
    }
  });
  return info;
}

class B2Storage {
  constructor(env) {
    this.kind = "b2";
    this.keyId = env.B2_KEY_ID;
    this.appKey = env.B2_APP_KEY;
    // 桶名不是密钥，允许在代码里给一个默认值；配了 B2_BUCKET 环境变量时以环境变量为准。
    this.bucketName = env.B2_BUCKET || DEFAULT_B2_BUCKET;
    // 只在离线测试时才需要指向本地假 B2
    this.authUrl = env.B2_AUTH_URL || B2_AUTH_URL;
  }

  async authorize(force = false) {
    const now = Date.now();
    const reusable =
      cachedAuth &&
      cachedAuth.keyId === this.keyId &&
      cachedAuth.bucketName === this.bucketName &&
      cachedAuth.expiresAt > now;
    if (!force && reusable) return cachedAuth;

    const response = await fetch(this.authUrl, {
      headers: { authorization: `Basic ${toBase64(`${this.keyId}:${this.appKey}`)}` },
    });
    if (!response.ok) {
      throw new Error(`B2 authorize ${response.status}: ${await response.text()}`);
    }
    const account = await response.json();

    const buckets = await this.call(account, "b2_list_buckets", { accountId: account.accountId });
    const bucket = (buckets.buckets || []).find((entry) => entry.bucketName === this.bucketName);
    if (!bucket) throw new Error(`B2 里找不到存储桶：${this.bucketName}`);

    cachedAuth = {
      keyId: this.keyId,
      bucketName: this.bucketName,
      authorizationToken: account.authorizationToken,
      apiUrl: account.apiUrl,
      downloadUrl: account.downloadUrl,
      accountId: account.accountId,
      bucketId: bucket.bucketId,
      expiresAt: now + AUTH_TTL,
    };
    return cachedAuth;
  }

  /** 调 b2api；令牌过期（401）自动重授权一次。 */
  async call(auth, path, body, retry = true) {
    const response = await fetch(`${auth.apiUrl}/b2api/v2/${path}`, {
      method: "POST",
      headers: { authorization: auth.authorizationToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.status === 401 && retry) {
      cachedAuth = null;
      return this.call(await this.authorize(true), path, body, false);
    }
    if (!response.ok) {
      throw new Error(`B2 ${path} ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  async uploadUrl(auth) {
    const now = Date.now();
    if (cachedUpload && cachedUpload.bucketId === auth.bucketId && cachedUpload.expiresAt > now) {
      return cachedUpload;
    }
    const created = await this.call(auth, "b2_get_upload_url", { bucketId: auth.bucketId });
    cachedUpload = {
      bucketId: auth.bucketId,
      uploadUrl: created.uploadUrl,
      authorizationToken: created.authorizationToken,
      expiresAt: now + UPLOAD_TTL,
    };
    return cachedUpload;
  }

  toItem(file) {
    const info = file.fileInfo || {};
    const uploaded = info.uploaded || (file.uploadTimestamp ? new Date(file.uploadTimestamp).toISOString() : "");
    return {
      key: file.fileName,
      fileId: file.fileId,
      size: file.contentLength || 0,
      uploaded,
      contentType: file.contentType || "",
      etag: (file.contentSha1 || "").slice(0, 32),
      metadata: { ...info, uploaded },
    };
  }

  async list({ limit = 24, cursor } = {}) {
    const auth = await this.authorize();
    const data = await this.call(auth, "b2_list_file_names", {
      bucketId: auth.bucketId,
      prefix: PHOTO_PREFIX,
      maxFileCount: Math.min(limit, 1000),
      ...(cursor ? { startFileName: cursor } : {}),
    });

    const items = (data.files || []).map((file) => this.toItem(file));
    // 键名里带的是倒序时间戳，名字升序 = 最新在前
    items.sort((a, b) => a.key.localeCompare(b.key));
    return { items, cursor: data.nextFileName || null, truncated: Boolean(data.nextFileName) };
  }

  async put(key, body, { contentType, cacheControl, metadata = {} }) {
    const auth = await this.authorize();
    const upload = await this.uploadUrl(auth);
    const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();

    const headers = new Headers();
    headers.set("authorization", upload.authorizationToken);
    headers.set("x-bz-file-name", encodeURIComponent(key));
    headers.set("content-type", contentType);
    headers.set("x-bz-content-sha1", await sha1Hex(bytes));
    if (cacheControl) headers.set("cache-control", cacheControl);
    for (const [name, value] of Object.entries(metadata)) {
      headers.set(`x-bz-info-${String(name).toLowerCase()}`, encodeURIComponent(String(value)));
    }

    const response = await fetch(upload.uploadUrl, { method: "POST", headers, body: bytes });
    if (response.status === 401) cachedUpload = null;
    if (!response.ok) {
      throw new Error(`B2 upload ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  fileUrl(auth, key) {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${auth.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${encodedKey}`;
  }

  async download(key, method = "GET") {
    const auth = await this.authorize();
    const response = await fetch(this.fileUrl(auth, key), {
      method,
      headers: { authorization: auth.authorizationToken },
    });
    if (response.status === 401) cachedAuth = null;
    return response;
  }

  async get(key) {
    const response = await this.download(key, "GET");
    if (!response.ok) return null;
    const metadata = fileInfoFromHeaders(response.headers);
    return {
      body: response.body,
      size: Number(response.headers.get("content-length") || 0),
      uploaded: metadata.uploaded || "",
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: (response.headers.get("x-bz-content-sha1") || "").slice(0, 32),
      metadata,
    };
  }

  async head(key) {
    const response = await this.download(key, "HEAD");
    if (!response.ok) return null;
    const metadata = fileInfoFromHeaders(response.headers);
    return {
      size: Number(response.headers.get("content-length") || 0),
      uploaded: metadata.uploaded || "",
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: (response.headers.get("x-bz-content-sha1") || "").slice(0, 32),
      metadata,
    };
  }

  async deleteMany(keys) {
    const auth = await this.authorize();
    for (const key of keys.slice(0, 50)) {
      // 删除要 fileId，先按名字精确查一条
      const listed = await this.call(auth, "b2_list_file_names", {
        bucketId: auth.bucketId,
        prefix: key,
        maxFileCount: 1,
      });
      const file = (listed.files || []).find((entry) => entry.fileName === key);
      if (file) {
        await this.call(auth, "b2_delete_file_version", {
          fileName: file.fileName,
          fileId: file.fileId,
        });
      }
    }
  }
}

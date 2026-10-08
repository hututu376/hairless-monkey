/**
 * 照片存储层：R2 和 Backblaze B2 二选一，接口完全一样。
 *
 * 优先用 R2（绑定了 PHOTO_BUCKET 就用它），否则用 B2（配好 B2_* 变量就用它），
 * 都没配就返回 null，页面上会提示"照片存储还没配置好"。
 */

import { signAwsRequest } from "./sigv4.js";

export const PHOTO_PREFIX = "photos/";

const byUploadedDesc = (a, b) => {
  const byTime = String(b.metadata?.uploaded || b.uploaded || "").localeCompare(
    String(a.metadata?.uploaded || a.uploaded || ""),
  );
  return byTime !== 0 ? byTime : b.key.localeCompare(a.key);
};

export function createStorage(env) {
  if (env.PHOTO_BUCKET) return new R2Storage(env.PHOTO_BUCKET);
  if (env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET && env.B2_ENDPOINT) return new B2Storage(env);
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

    return {
      items: items.sort(byUploadedDesc),
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

const base64url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64url = (value) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

const decodeXml = (value) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Workers 里没有 DOMParser，ListObjectsV2 的结构又很固定，这里用正则取字段。 */
function parseListObjects(xml) {
  const contents = [];
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    contents.push({
      key: decodeXml(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] || 0),
      lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] || "",
      etag: decodeXml(/<ETag>([^<]*)<\/ETag>/.exec(block)?.[1] || "").replace(/"/g, ""),
    });
  }
  return {
    contents,
    truncated: /<IsTruncated>true<\/IsTruncated>/i.test(xml),
    nextToken: decodeXml(
      /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] || "",
    ),
  };
}

function metadataFromHeaders(headers) {
  const encoded = headers.get("x-amz-meta-json");
  if (encoded) {
    try {
      return JSON.parse(fromBase64url(encoded));
    } catch {
      return {};
    }
  }
  const plain = {};
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-") && name !== "x-amz-meta-json") {
      plain[name.slice("x-amz-meta-".length)] = value;
    }
  });
  return plain;
}

function regionFromEndpoint(endpoint, fallback) {
  const host = new URL(endpoint).host;
  const match = /^s3[.-]([a-z0-9-]+)\.backblazeb2\.com$/i.exec(host);
  return match?.[1] || fallback || "us-west-004";
}

class B2Storage {
  constructor(env) {
    this.kind = "b2";
    this.bucket = env.B2_BUCKET;
    this.endpoint = String(env.B2_ENDPOINT).replace(/\/+$/, "");
    this.keyId = env.B2_KEY_ID;
    this.appKey = env.B2_APP_KEY;
    this.region = regionFromEndpoint(this.endpoint, env.B2_REGION);
  }

  async request(method, key, { query, headers = {}, body } = {}) {
    const path =
      `${this.endpoint}/${encodeURIComponent(this.bucket)}` +
      (key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "");
    const url = new URL(path);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
      }
    }

    const signed = await signAwsRequest({
      accessKeyId: this.keyId,
      secretAccessKey: this.appKey,
      region: this.region,
      service: "s3",
      method,
      url: url.toString(),
      headers,
      body,
    });

    return fetch(url.toString(), { method, headers: signed, body });
  }

  async put(key, body, { contentType, cacheControl, metadata = {} }) {
    const headers = {
      "content-type": contentType,
      "cache-control": cacheControl,
      // B2 的自定义元数据走 HTTP 头，值必须是 ASCII，所以整块 JSON 做 base64url。
      "x-amz-meta-json": base64url(JSON.stringify(metadata)),
    };
    const response = await this.request("PUT", key, { headers, body });
    if (!response.ok) {
      throw new Error(`B2 put failed: ${response.status} ${await response.text()}`);
    }
  }

  async get(key) {
    const response = await this.request("GET", key);
    if (!response.ok) return null;
    return {
      body: response.body,
      size: Number(response.headers.get("content-length") || 0),
      uploaded: metadataFromHeaders(response.headers).uploaded || "",
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: (response.headers.get("etag") || "").replace(/"/g, ""),
      metadata: metadataFromHeaders(response.headers),
    };
  }

  async head(key) {
    const response = await this.request("HEAD", key);
    if (!response.ok) return null;
    return {
      size: Number(response.headers.get("content-length") || 0),
      uploaded: metadataFromHeaders(response.headers).uploaded || "",
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: (response.headers.get("etag") || "").replace(/"/g, ""),
      metadata: metadataFromHeaders(response.headers),
    };
  }

  async deleteMany(keys) {
    await Promise.all(keys.slice(0, 20).map((key) => this.request("DELETE", key)));
  }

  async list({ limit = 24, cursor } = {}) {
    const response = await this.request("GET", "", {
      query: {
        "list-type": "2",
        prefix: PHOTO_PREFIX,
        "max-keys": limit,
        "continuation-token": cursor || "",
      },
    });
    if (!response.ok) {
      throw new Error(`B2 list failed: ${response.status} ${await response.text()}`);
    }

    const { contents, truncated, nextToken } = parseListObjects(await response.text());

    // S3 的 list 不返回自定义元数据，只能对每条再取一次头部（每页最多 24 条）。
    const items = await Promise.all(
      contents.map(async (entry) => {
        const head = await this.head(entry.key).catch(() => null);
        return {
          key: entry.key,
          size: head?.size || entry.size,
          uploaded:
            head?.uploaded ||
            (entry.lastModified ? new Date(entry.lastModified).toISOString() : ""),
          contentType: head?.contentType || "",
          etag: head?.etag || entry.etag,
          metadata: head?.metadata || {},
        };
      }),
    );

    return {
      items: items.sort(byUploadedDesc),
      cursor: truncated ? nextToken || null : null,
      truncated,
    };
  }
}

/**
 * 本地假 Backblaze B2（只实现站点用到的那几个 S3 接口），用来离线验证 B2 存储通道。
 *
 *   node tools/mock-b2.mjs                  # 监听 9100
 *   B2_BUCKET=test-bucket node tools/mock-b2.mjs
 *
 * 它会独立实现一遍 AWS SigV4 校验（Node 的 crypto），
 * 如果 Worker 那边签名算错，这里会立刻打印 mismatch，而不是等真上传到 B2 才发现。
 */

import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 9100);
const ACCESS_KEY = process.env.B2_KEY_ID || "test-key";
const SECRET_KEY = process.env.B2_APP_KEY || "test-secret";
const REGION = process.env.B2_REGION || "us-west-004";
const SERVICE = "s3";
const BUCKET = process.env.B2_BUCKET || "test-bucket";

/** key -> { body: Buffer, contentType, cacheControl, metaJson, lastModified } */
const objects = new Map();

const rfc3986 = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function canonicalQueryFromRaw(rawQuery) {
  if (!rawQuery) return "";
  return rawQuery
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? "" : pair.slice(index + 1);
      return [rfc3986(decodeURIComponent(key)), rfc3986(decodeURIComponent(value))];
    })
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalPathFromRaw(rawPath) {
  return rawPath
    .split("/")
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join("/");
}

/** 按 AWS 规范独立复算一遍签名，和 Worker 里的实现对比。 */
function verifySignature(request, body) {
  const authorization = request.headers.authorization || "";
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
      authorization,
    );
  if (!parsed) return { ok: false, reason: "no AWS4-HMAC-SHA256 authorization header" };

  const [, accessKey, scope, signedHeaders, signature] = parsed;
  const [dateStamp, region, service, terminator] = scope.split("/");
  const amzDate = request.headers["x-amz-date"];
  const payloadHash = request.headers["x-amz-content-sha256"];
  if (accessKey !== ACCESS_KEY) return { ok: false, reason: `unexpected access key ${accessKey}` };
  if (terminator !== "aws4_request") return { ok: false, reason: "bad scope terminator" };

  const expectedPayload = body && body.length ? sha256Hex(body) : sha256Hex("");
  if (payloadHash !== expectedPayload) {
    return { ok: false, reason: `x-amz-content-sha256 mismatch (${payloadHash} != ${expectedPayload})` };
  }

  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => `${name}:${String(request.headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalRequest = [
    request.method,
    canonicalPathFromRaw(request.url.split("?")[0]),
    canonicalQueryFromRaw(request.url.split("?")[1]),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${region}/${service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), region), service), "aws4_request");
  const expected = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  if (region !== REGION) return { ok: false, reason: `unexpected region ${region}` };
  if (expected.length !== signature.length) return { ok: false, reason: "signature length mismatch" };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return { ok: false, reason: `signature mismatch: got ${signature}, expected ${expected}` };
  }
  return { ok: true };
}

const xmlEscape = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function listResponse(prefix, maxKeys, token) {
  const keys = Array.from(objects.keys())
    .filter((key) => key.startsWith(prefix))
    .sort();
  const start = token ? keys.findIndex((key) => key > token) : 0;
  const slice = keys.slice(start === -1 ? keys.length : start, (start === -1 ? keys.length : start) + maxKeys);
  const truncated = start !== -1 && start + slice.length < keys.length;

  const contents = slice
    .map((key) => {
      const object = objects.get(key);
      return [
        "<Contents>",
        `<Key>${xmlEscape(key)}</Key>`,
        `<LastModified>${object.lastModified}</LastModified>`,
        `<ETag>"${sha256Hex(object.body).slice(0, 32)}"</ETag>`,
        `<Size>${object.body.length}</Size>`,
        "<StorageClass>STANDARD</StorageClass>",
        "</Contents>",
      ].join("");
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(BUCKET)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${slice.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
    truncated ? `<NextContinuationToken>${xmlEscape(slice[slice.length - 1])}</NextContinuationToken>` : ""
  }${contents}</ListBucketResult>`;
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const verification = verifySignature(request, body);
    const [rawPath, rawQuery = ""] = request.url.split("?");
    const segments = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
    const bucket = segments[0];
    const key = segments.slice(1).join("/");

    console.log(
      `${request.method} ${request.url} -> ${verification.ok ? "sig ok" : `SIG FAIL: ${verification.reason}`}`,
    );

    if (!verification.ok) {
      response.writeHead(403, { "content-type": "application/xml" });
      response.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    if (bucket !== BUCKET) {
      response.writeHead(404);
      response.end("no such bucket");
      return;
    }

    const params = new URLSearchParams(rawQuery);

    if (request.method === "GET" && !key && params.get("list-type") === "2") {
      const xml = listResponse(
        params.get("prefix") || "",
        Number(params.get("max-keys") || 1000),
        params.get("continuation-token") || "",
      );
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(xml);
      return;
    }

    if (request.method === "PUT" && key) {
      objects.set(key, {
        body,
        contentType: request.headers["content-type"] || "application/octet-stream",
        cacheControl: request.headers["cache-control"] || "",
        metaJson: request.headers["x-amz-meta-json"] || "",
        lastModified: new Date().toISOString(),
      });
      response.writeHead(200, { etag: `"${sha256Hex(body).slice(0, 32)}"` });
      response.end();
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && key) {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404, { "content-type": "application/xml" });
        response.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      response.writeHead(200, {
        "content-type": object.contentType,
        "cache-control": object.cacheControl,
        "content-length": String(object.body.length),
        etag: `"${sha256Hex(object.body).slice(0, 32)}"`,
        "last-modified": object.lastModified,
        "x-amz-meta-json": object.metaJson,
      });
      response.end(request.method === "HEAD" ? undefined : object.body);
      return;
    }

    if (request.method === "DELETE" && key) {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(400);
    response.end("unsupported request");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock B2 listening on http://127.0.0.1:${PORT} (bucket: ${BUCKET})`);
});

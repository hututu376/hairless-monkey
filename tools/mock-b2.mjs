/**
 * 本地假 Backblaze B2（只实现站点用到的原生 API），用来离线验证 B2 存储通道。
 *
 *   node tools/mock-b2.mjs        # 监听 9100
 *
 * 配合：
 *   npx wrangler dev --port 8787 \
 *     --var B2_AUTH_URL:http://127.0.0.1:9100/b2api/v2/b2_authorize_account \
 *     --var B2_KEY_ID:test-key --var B2_APP_KEY:test-secret --var B2_BUCKET:test-bucket
 *
 * 它会校验 X-Bz-Content-Sha1、X-Bz-Info-* 的编码，以及删除是否真的生效，
 * 有问题会在日志里直接报出来。
 */

import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 9100);
const BUCKET_NAME = process.env.B2_BUCKET || "test-bucket";
const BUCKET_ID = "mock-bucket-id";
const API_TOKEN = "mock-api-token";
const UPLOAD_TOKEN = "mock-upload-token";

/** key -> { body, contentType, sha1, info: {name: value}, uploadTimestamp } */
const objects = new Map();

const readJson = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });

const sendJson = (response, data, status = 200) => {
  const body = JSON.stringify(data);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const publicFile = (key) => {
  const object = objects.get(key);
  return {
    accountId: "mock-account",
    action: "upload",
    bucketId: BUCKET_ID,
    contentLength: object.body.length,
    contentSha1: object.sha1,
    contentType: object.contentType,
    fileId: `mock-file-${key}`,
    fileInfo: object.info,
    fileName: key,
    uploadTimestamp: object.uploadTimestamp,
  };
};

const server = http.createServer(async (request, response) => {
  const base = `http://127.0.0.1:${PORT}`;
  const [path, rawQuery = ""] = request.url.split("?");
  const query = new URLSearchParams(rawQuery);

  if (path === "/b2api/v2/b2_authorize_account") {
    if (!request.headers.authorization?.startsWith("Basic ")) {
      return sendJson(response, { code: "unauthorized", message: "missing basic auth" }, 401);
    }
    return sendJson(response, {
      accountId: "mock-account",
      authorizationToken: API_TOKEN,
      apiUrl: base,
      downloadUrl: base,
      allowed: { capabilities: ["listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"] },
    });
  }

  if (!path.startsWith("/b2api/v2/") && path !== "/upload") {
    // 文件下载走这里
    const match = /^\/file\/([^/]+)\/(.+)$/.exec(path);
    if (match) {
      const key = match[2].split("/").map(decodeURIComponent).join("/");
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404);
        return response.end("not found");
      }
      const headers = {
        "content-type": object.contentType,
        "content-length": String(object.body.length),
        "x-bz-content-sha1": object.sha1,
        "x-bz-file-name": encodeURIComponent(key),
      };
      for (const [name, value] of Object.entries(object.info)) {
        headers[`x-bz-info-${name}`] = encodeURIComponent(value);
      }
      response.writeHead(200, headers);
      return response.end(request.method === "HEAD" ? undefined : object.body);
    }
    response.writeHead(404);
    return response.end("not found");
  }

  if (path === "/upload") {
    if (request.headers.authorization !== UPLOAD_TOKEN) {
      return sendJson(response, { code: "unauthorized", message: "bad upload token" }, 401);
    }
    const body = await readBody(request);
    const key = decodeURIComponent(request.headers["x-bz-file-name"] || "");
    if (!key) return sendJson(response, { code: "bad_request", message: "missing file name" }, 400);

    const expected = request.headers["x-bz-content-sha1"];
    const actual = crypto.createHash("sha1").update(body).digest("hex");
    if (expected !== actual) {
      console.log(`  !! sha1 mismatch for ${key}: got ${expected}, expected ${actual}`);
      return sendJson(response, { code: "bad_request", message: "sha1 mismatch" }, 400);
    }

    const info = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!name.startsWith("x-bz-info-")) continue;
      info[name.slice("x-bz-info-".length)] = decodeURIComponent(String(value));
    }

    objects.set(key, {
      body,
      contentType: request.headers["content-type"] || "application/octet-stream",
      sha1: actual,
      info,
      uploadTimestamp: Date.now(),
    });
    console.log(`  upload ${key} (${body.length} bytes, info=${JSON.stringify(info)})`);
    return sendJson(response, publicFile(key));
  }

  if (request.headers.authorization !== API_TOKEN) {
    return sendJson(response, { code: "unauthorized", message: "bad api token" }, 401);
  }

  const body = await readJson(request);

  if (path === "/b2api/v2/b2_list_buckets") {
    return sendJson(response, {
      buckets: [{ accountId: "mock-account", bucketId: BUCKET_ID, bucketName: BUCKET_NAME, bucketType: "allPrivate" }],
    });
  }

  if (path === "/b2api/v2/b2_list_file_names") {
    const prefix = body.prefix || "";
    const startFileName = body.startFileName || "";
    const max = body.maxFileCount || 1000;
    const keys = Array.from(objects.keys())
      .filter((key) => key.startsWith(prefix) && key >= startFileName)
      .sort();
    const slice = keys.slice(0, max);
    const next = keys.length > slice.length ? keys[slice.length] : null;
    console.log(`  list prefix=${JSON.stringify(prefix)} -> ${slice.length} 条${next ? " (还有下一页)" : ""}`);
    return sendJson(response, {
      files: slice.map(publicFile),
      nextFileName: next,
    });
  }

  if (path === "/b2api/v2/b2_get_upload_url") {
    return sendJson(response, { bucketId: BUCKET_ID, uploadUrl: `${base}/upload`, authorizationToken: UPLOAD_TOKEN });
  }

  if (path === "/b2api/v2/b2_delete_file_version") {
    const key = body.fileName;
    const existed = objects.delete(key);
    console.log(`  delete ${key} -> ${existed ? "ok" : "not found"}`);
    if (!existed) return sendJson(response, { code: "not_found", message: "no such file" }, 404);
    return sendJson(response, { fileName: key, fileId: body.fileId });
  }

  response.writeHead(404);
  response.end(JSON.stringify({ code: "not_found", message: path }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock B2 (native API) listening on http://127.0.0.1:${PORT} (bucket: ${BUCKET_NAME})`);
});

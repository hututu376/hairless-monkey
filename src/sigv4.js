/**
 * 极简 AWS Signature V4 签名（WebCrypto 实现，零依赖）。
 *
 * Backblaze B2 的 S3 兼容接口用的就是这套签名，Worker 里没有 Node 的 crypto 模块，
 * 所以这里用 crypto.subtle 自己算，避免额外依赖。
 */

const encoder = new TextEncoder();

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key, data) {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, typeof data === "string" ? encoder.encode(data) : data);
}

/** RFC 3986 编码，AWS 要求把 !'()* 也转义。 */
const encodeRfc3986 = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalPath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(searchParams) {
  const pairs = [];
  searchParams.forEach((value, key) => pairs.push([encodeRfc3986(key), encodeRfc3986(value)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function amzDateString(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * @returns {Promise<Record<string,string>>} 可以直接交给 fetch 的请求头（含 Authorization）
 */
export async function signAwsRequest({
  accessKeyId,
  secretAccessKey,
  region,
  service = "s3",
  method,
  url,
  headers = {},
  body,
  date = new Date(),
}) {
  const parsed = new URL(url);
  const amzDate = amzDateString(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;

  const signed = {};
  for (const [key, value] of Object.entries(headers)) {
    signed[key.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  }
  signed.host = parsed.host;
  signed["x-amz-content-sha256"] = payloadHash;
  signed["x-amz-date"] = amzDate;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    canonicalPath(parsed.pathname),
    canonicalQuery(parsed.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await hmac(
    await hmac(await hmac(await hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = toHex(await hmac(signingKey, stringToSign));

  // host 由运行时自动带上，不能手动设置，其余签名头照原样发出去。
  return {
    ...headers,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

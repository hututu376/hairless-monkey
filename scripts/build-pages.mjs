/**
 * 生成 Cloudflare Pages 用的部署目录 pages-dist/：
 *   1. 复制 public/ 里的静态资源
 *   2. 把 src/index.js 打包成单文件 _worker.js（Pages 高级模式，接口照常工作）
 *
 * 用法：npm run pages:build
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "pages-dist");
const workerFile = path.join(outDir, "_worker.js");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(path.join(root, "public"), outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "src/index.js")],
  outfile: workerFile,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

const { size } = await stat(workerFile);
console.log(`pages-dist 已生成：静态资源 + _worker.js（${(size / 1024).toFixed(1)} KB）`);

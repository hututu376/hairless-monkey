# 无毛猴

一个 Apple 风格的单页站点：认识无毛猴、看精选相册、访客上传照片，上传后所有人都能看到。

- 前台：`public/` 纯静态资源（HTML / CSS / JS，没有构建步骤）
- 接口：`src/index.js` Cloudflare Worker，处理 `/api/*`
- 存储：Cloudflare R2（照片文件 + 上传者昵称、说明、尺寸等元数据）
- 管理：`/manage.html` 可以删除照片，需要 `ADMIN_TOKEN`

## 目录结构

```
public/
  index.html                    首页（首屏 / 认识 / 照顾 / 相册 / 上传）
  manage.html                   管理后台
  assets/style.css, app.js, manage.js
  assets/data/curated.json      精选相册清单（由脚本生成，含低清占位图）
  media/hero.jpg, side.jpg      首屏与内文配图
  media/gallery/*.jpg           精选相册图（长边 1600）
src/index.js                    Worker：上传 / 列表 / 读图 / 删除
scripts/build-photos.py         原始照片 → 网页尺寸
tools/verify.mjs                本地自动化校验
wrangler.jsonc                  部署配置
```

## 本地预览

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

本地跑的是模拟的 R2，上传的照片会存在项目里的 `.wrangler/` 目录，不会动到云端数据。

想顺便跑一遍浏览器校验（需要本机装了 Chrome）：

```bash
npm run verify
```

它会用 4 个视口检查横向溢出、文字溢出、图片加载、相册是否重叠，并真的走一遍上传流程，截图落在 `.shots/`。

## 部署到 Cloudflare

在控制台里「拖拽上传」只能传纯静态文件，传不了上传接口，所以这个站要用命令行部署一次：

```bash
npx wrangler login
npx wrangler r2 bucket create hairless-monkey-photos
npm run deploy
```

部署完成后会给出 `https://hairless-monkey.<你的子域>.workers.dev`。
想用自己的域名，就在控制台的 Workers → 该项目 → Settings → Domains & Routes 里绑定，Cloudflare 会自动签证书。

两个要注意的地方：

- R2 第一次使用需要在控制台里开通（免费额度内不收费，但需要绑定支付方式）。
- 桶名要和 `wrangler.jsonc` 里的 `bucket_name` 一致；想换名字就两处一起改。

## 可选配置

设置管理口令，之后 `/manage.html` 才能删除照片：

```bash
npx wrangler secret put ADMIN_TOKEN
```

开启人机校验（Turnstile），防止被机器人刷图：

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

然后在 `wrangler.jsonc` 里补上站点公钥：

```jsonc
"vars": {
  "TURNSTILE_SITE_KEY": "0x4AAA..."
}
```

只配一半不会生效：没设 `TURNSTILE_SECRET_KEY` 时服务端会跳过校验，前端也不会显示验证码。

## 更新精选照片

精选照片默认读项目旁边的 `../photo`（也就是 `E:\我的网站\无毛猴\photo`），处理脚本会重写 `public/media/` 和 `public/assets/data/curated.json`：

```bash
npm run photos
npm run deploy
```

照片放在别的盘就加参数：`python scripts/build-photos.py --src "D:/照片/无毛猴"`。

想换首屏图和内文配图，改 `scripts/build-photos.py` 顶部的 `HERO_FILE` / `SIDE_FILE` 即可（留空则按亮度和清晰度自动挑）。

访客上传的照片存在 R2 里，加照片不用重新部署。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 上传上限、Turnstile 公钥、存储是否就绪 |
| GET | `/api/photos?limit=&cursor=` | 相册列表，按上传时间倒序，游标分页 |
| POST | `/api/upload` | 上传照片（`multipart/form-data`：`photo`、`uploader`、`caption`、`width`、`height`） |
| GET | `/api/image/<key>` | 读取照片，加 `?download=1` 下载 |
| POST | `/api/delete` | 删除照片，JSON 传 `{ token, key }` 或 `{ token, keys: [] }` |

## 数据与限制

- 单张上限 10 MB；前端会先把照片压到长边 2400、JPEG 质量 0.88 再传，手机原图通常压到 1 MB 以内
- 只接受 JPG / PNG / WebP / GIF / AVIF，服务端按文件头判断真实类型，不信任客户端
- 文件名由服务端改写为随机键，压缩过程同时丢弃 EXIF（含定位信息）
- 列表默认每页 24 条，最多 60 条
- R2 图片响应带一年期 `immutable` 缓存，同一张图只回源一次

## 常见问题

- 上传报 `storage_not_configured`：R2 绑定没生效，检查桶是否创建、名字是否和 `wrangler.jsonc` 一致，然后重新 `npm run deploy`。
- 删除提示 `admin_disabled`：还没设置 `ADMIN_TOKEN`。
- 页面能打开但相册一直显示「云端相册暂时连不上」：说明接口没起来（比如只部署了 `public/` 静态文件），把 Worker 一起部署即可。

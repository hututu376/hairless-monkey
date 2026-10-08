# 无毛猴

一个 Apple 风格的单页站点：认识无毛猴、看精选相册、访客上传照片，上传后所有人都能看到。

- 前台：`public/` 纯静态资源（HTML / CSS / JS，没有构建步骤）
- 接口：`src/index.js` Cloudflare Worker，处理 `/api/*`
- 存储：`src/storage.js` 一套接口，**Backblaze B2** 或 **Cloudflare R2** 二选一
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
src/index.js                    Worker 路由：上传 / 列表 / 读图 / 删除
src/storage.js                  R2 与 B2 两个存储实现
src/sigv4.js                    AWS SigV4 签名（零依赖，给 B2 用）
scripts/build-photos.py         原始照片 → 网页尺寸
tools/verify.mjs                浏览器端自动化校验
tools/mock-b2.mjs               本地假 B2，离线验证存储通道
wrangler.jsonc                  部署配置
```

## 本地预览

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

本地跑的是模拟存储，上传的照片只留在本机 `.wrangler/` 目录，不会动到云端数据。

浏览器校验（需要本机装了 Chrome）：

```bash
npm run verify
```

四个视口检查横向溢出、文字溢出、图片加载、相册重叠，并真的走一遍上传流程，截图落在 `.shots/`。

想单独验证 B2 通道（不用真账号）：

```bash
node tools/mock-b2.mjs      # 另开一个窗口，监听 9100
npx wrangler dev --port 8787 --var B2_BUCKET:test-bucket --var B2_ENDPOINT:http://127.0.0.1:9100 \
  --var B2_KEY_ID:test-key --var B2_APP_KEY:test-secret --var B2_REGION:us-west-004
```

假 B2 会独立复算一遍 SigV4，签名不对会打印 `SIG FAIL`。

## 部署到 Cloudflare

在控制台里「拖拽上传」只能传纯静态文件，传不了上传接口，所以要用命令行部署一次：

```bash
npx wrangler login
npm run deploy
```

部署完成后会给出 `https://hairless-monkey.<你的子域>.workers.dev`。
想用自己的域名，在控制台的 Workers → 该项目 → Settings → Domains & Routes 里绑定。

如果走 GitHub 自动部署，构建命令填 `npm install`，部署命令填 `npx wrangler deploy`；
之后 `git push` 就会自动重新部署。

## 照片存储：Backblaze B2（默认）或 Cloudflare R2

代码会自动选：绑定了 R2 就用 R2，否则用 B2，两个都没配就在页面上提示「照片存储还没配置好」。

### A. Backblaze B2

1. 到 [backblaze.com](https://www.backblaze.com/cloud-storage) 注册，进入 **B2 Cloud Storage**。
2. **Create a Bucket**：名字如 `hairless-monkey-photos`，类型选 **Private**（照片不直接对外，由 Worker 代理）。
3. **Application Keys → Add a New Application Key**：权限限定到上面这个 bucket，勾选 Read and Write。
4. 记下四样东西：`keyID`、`applicationKey`、bucket 名，以及 bucket 详情里的 Endpoint（形如 `s3.us-west-004.backblazeb2.com`）。
5. 把密钥存到 Worker（不会进仓库）：

   ```bash
   npx wrangler secret put B2_KEY_ID
   npx wrangler secret put B2_APP_KEY
   ```

6. bucket 名和 Endpoint 不是密钥，写在 `wrangler.jsonc` 的 `vars` 里即可：

   ```jsonc
   "vars": {
     "B2_BUCKET": "hairless-monkey-photos",
     "B2_ENDPOINT": "https://s3.us-west-004.backblazeb2.com"
   }
   ```

   或者同样用 `npx wrangler secret put B2_BUCKET` / `B2_ENDPOINT` 设置。

7. `npm run deploy`。部署后打开 `/api/config`，看到 `"storage":"b2"` 就说明接上了。

B2 免费额度是 10 GB 存储，日常下载 1 GB/天；图片响应带一年期 `immutable` 缓存，同一张照片只回源一次，正常流量够用。

### B. Cloudflare R2

1. 控制台启用 R2（免费额度 10 GB，需要绑支付方式）。
2. `npx wrangler r2 bucket create hairless-monkey-photos`
3. 把 `wrangler.jsonc` 里 `r2_buckets` 那段注释取消，桶名保持一致。
4. `npm run deploy`，`/api/config` 会显示 `"storage":"r2"`。

R2 没有出网流量费，如果站点访问量大可以选它。

## 可选配置

设置管理口令，之后 `/manage.html` 才能删除照片：

```bash
npx wrangler secret put ADMIN_TOKEN
```

开启人机校验（Turnstile），防止被机器人刷图：

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

然后在 `wrangler.jsonc` 的 `vars` 里补上站点公钥：

```jsonc
"TURNSTILE_SITE_KEY": "0x4AAA..."
```

只配一半不会生效：没设 `TURNSTILE_SECRET_KEY` 时服务端跳过校验，前端也不显示验证码。

## 更新精选照片

精选照片默认读项目旁边的 `../photo`（也就是 `E:\我的网站\无毛猴\photo`），脚本会重写 `public/media/` 和 `public/assets/data/curated.json`：

```bash
npm run photos
npm run deploy
```

照片放在别的盘就加参数：`python scripts/build-photos.py --src "D:/照片/无毛猴"`。

想换首屏图和内文配图，改 `scripts/build-photos.py` 顶部的 `HERO_FILE` / `SIDE_FILE`。

访客上传的照片存在 B2/R2 里，加照片不用重新部署。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 上传上限、Turnstile 公钥、存储是否就绪、用的是哪种存储 |
| GET | `/api/photos?limit=&cursor=` | 相册列表，按上传时间倒序，游标分页 |
| POST | `/api/upload` | 上传照片（`multipart/form-data`：`photo`、`uploader`、`caption`、`width`、`height`） |
| GET | `/api/image/<key>` | 读取照片，加 `?download=1` 下载 |
| POST | `/api/delete` | 删除照片，JSON 传 `{ token, key }` 或 `{ token, keys: [] }` |

## 数据与限制

- 单张上限 10 MB；前端先压到长边 2400、JPEG 质量 0.88 再传，手机原图通常压到 1 MB 以内
- 只接受 JPG / PNG / WebP / GIF / AVIF，服务端按文件头判断真实类型
- 文件名由服务端改写为随机键，压缩过程丢弃 EXIF（含定位信息）
- 对象键带倒序时间戳，字典序即上传时间倒序，翻页稳定
- 列表默认每页 24 条，最多 60 条；B2 每条会额外取一次头部拿元数据（每页最多 24 次）
- 自定义元数据在 B2 上以 base64url JSON 存放，避免中文昵称在 HTTP 头里出问题

## 常见问题

- 页面上提示「照片存储还没配置好」：B2 的四个变量/密钥没配全，或 R2 桶没建、名字不一致。
- 上传报 503：同上，服务端拿不到存储配置。
- `/api/config` 里 `storage` 是 `null`：两种存储都没接上。
- 删除提示 `admin_disabled`：还没设置 `ADMIN_TOKEN`。
- B2 上传报 403：Application Key 没给 Read and Write，或 Endpoint 区域写错了。
- 页面能打开但相册显示「云端相册暂时连不上」：接口没起来（比如只部署了 `public/` 静态文件）。

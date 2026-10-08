/**
 * 本地校验脚本：用真实浏览器打开站点，检查布局、文本溢出、图片加载与上传链路。
 *
 *   node tools/verify.mjs                          # 默认 http://127.0.0.1:8787
 *   BASE_URL=http://localhost:8788 node tools/verify.mjs
 *
 * 需要本机已安装 Chrome；不会下载额外的浏览器。
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const SHOT_DIR = process.env.SHOT_DIR || ".shots";
const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((candidate) => fs.existsSync(candidate));

if (!CHROME) {
  console.error("找不到 Chrome/Edge，可用 CHROME_PATH 指定路径");
  process.exit(1);
}

const problems = [];
const passes = [];

const expect = (condition, message) => {
  if (condition) passes.push(message);
  else problems.push(message);
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "laptop", width: 1180, height: 800, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "small-mobile", width: 320, height: 720, mobile: true },
];

const SAMPLE_PHOTO = fs
  .readdirSync("public/media/gallery")
  .filter((name) => name.endsWith(".jpg"))
  .map((name) => path.resolve("public/media/gallery", name))[0];

fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: path.resolve(SHOT_DIR, "chrome-profile"),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

const geometryProbe = () => {
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    };
  };
  const overlaps = (a, b) =>
    a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;

  const clipped = [];
  document
    .querySelectorAll("h1, h2, h3, .btn, .segmented button, .field__label, .footer__nav a")
    .forEach((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (element.getClientRects().length === 0) return;
      if (element.scrollWidth > element.clientWidth + 2) {
        clipped.push({
          text: element.textContent.trim().slice(0, 24),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        });
      }
    });

  const images = Array.from(document.images)
    .filter((img) => img.getAttribute("src"))
    .map((img) => ({
    src: img.currentSrc || img.src,
    natural: `${img.naturalWidth}x${img.naturalHeight}`,
    }));

  const items = Array.from(document.querySelectorAll(".gallery__item")).map(box);
  let itemOverlaps = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (overlaps(items[i], items[j])) itemOverlaps += 1;
    }
  }

  const hero = document.querySelector(".hero");
  const about = document.querySelector("#about");
  const heroCopy = box(document.querySelector(".hero__copy"));
  const heroFigure = box(document.querySelector(".hero__figure"));

  return {
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    clipped,
    brokenImages: Array.from(document.images)
      .filter((img) => img.getAttribute("src"))
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src),
    pendingImages: images.filter((image) => image.natural.startsWith("0x")).length,
    imageCount: images.length,
    missingAlt: Array.from(document.images).filter((img) => !img.hasAttribute("alt")).length,
    galleryItems: items.length,
    itemOverlaps,
    copyFigureOverlap: overlaps(heroCopy, heroFigure),
    heroCopy,
    heroFigure,
    hero: box(hero),
    about: box(about),
    nav: box(document.querySelector(".nav__inner")),
    navLinksDisplay: getComputedStyle(document.querySelector(".nav__links")).display,
    navToggleDisplay: getComputedStyle(document.querySelector(".nav__toggle")).display,
    viewportHeight: window.innerHeight,
  };
};

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.mobile,
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => consoleErrors.push(`requestfailed: ${request.url()}`));

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle2", timeout: 45000 });
  await page
    .waitForFunction('document.querySelectorAll(".gallery__item").length > 0', { timeout: 20000 })
    .catch(() => problems.push(`${viewport.name}: 相册没有渲染出任何照片`));

  // 先滚动一遍触发懒加载，再回到顶部做几何检查。
  await page
    .evaluate(async () => {
      const root = document.documentElement;
      const previous = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 400));
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      root.style.scrollBehavior = previous;
    })
    .catch(() => {});
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(
          Array.from(document.images).map((img) =>
            img.complete
              ? true
              : new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                }),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]),
    )
    .catch(() => {});

  const report = await page.evaluate(geometryProbe);

  expect(report.overflowX <= 1, `${viewport.name}: 没有横向溢出 (${report.overflowX}px)`);
  expect(
    report.clipped.length === 0,
    `${viewport.name}: 文字没有溢出容器 ${JSON.stringify(report.clipped)}`,
  );
  expect(
    report.brokenImages.length === 0,
    `${viewport.name}: 图片全部加载成功（共 ${report.imageCount} 张）`,
  );
  expect(report.pendingImages === 0, `${viewport.name}: 没有一直挂着的图片 (${report.pendingImages})`);
  expect(report.missingAlt === 0, `${viewport.name}: 所有 img 都有 alt`);
  expect(report.galleryItems > 0, `${viewport.name}: 相册渲染了 ${report.galleryItems} 张`);
  expect(report.itemOverlaps === 0, `${viewport.name}: 相册没有相互重叠 (${report.itemOverlaps})`);
  expect(
    !report.copyFigureOverlap,
    `${viewport.name}: 首屏文案与图片不重叠 copy=${JSON.stringify(report.heroCopy)} figure=${JSON.stringify(report.heroFigure)}`,
  );
  expect(report.nav.height <= 50, `${viewport.name}: 导航高度 ${report.nav.height}px`);
  expect(
    report.about.y > 0 && report.about.y < report.viewportHeight,
    `${viewport.name}: 首屏能看到下一段内容 (${report.about.y} < ${report.viewportHeight})`,
  );
  expect(report.hero.height > 380, `${viewport.name}: 首屏高度充足 (${report.hero.height}px)`);

  if (viewport.width >= 860) {
    expect(report.navLinksDisplay !== "none", `${viewport.name}: 桌面导航显示链接`);
    expect(report.navToggleDisplay === "none", `${viewport.name}: 桌面隐藏汉堡按钮`);
  } else {
    expect(report.navToggleDisplay !== "none", `${viewport.name}: 移动端显示汉堡按钮`);
  }

  if (viewport.width === 1440) {
    expect(report.imageCount >= 17, `desktop: 至少 17 张图片（当前 ${report.imageCount}）`);
  }

  await page.screenshot({ path: path.join(SHOT_DIR, `${viewport.name}.png`), fullPage: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${viewport.name}-hero.png`) });

  expect(
    consoleErrors.length === 0,
    `${viewport.name}: 控制台无报错 ${JSON.stringify(consoleErrors.slice(0, 3))}`,
  );
  await page.close();
}

// ---- 交互：灯箱、上传、筛选（桌面执行一次） ----
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const interactionErrors = [];
page.on("pageerror", (error) => interactionErrors.push(error.message));
await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle2", timeout: 45000 });
await page.waitForSelector(".gallery__item", { timeout: 20000 });

await page.click(".gallery__item");
await page
  .waitForFunction('!document.querySelector("#lightbox").hidden', { timeout: 5000 })
  .catch(() => {});
const lightbox = await page.evaluate(() => {
  const overlay = document.querySelector("#lightbox");
  const image = document.querySelector("#lightboxImage");
  return {
    visible: !overlay.hidden,
    loaded: image.complete && image.naturalWidth > 0,
  };
});
expect(lightbox.visible, "灯箱：点击照片后打开");
expect(lightbox.loaded, "灯箱：大图加载成功");
await page.keyboard.press("Escape");
await page
  .waitForFunction('document.querySelector("#lightbox").hidden', { timeout: 5000 })
  .catch(() => {});
expect(
  await page.evaluate(() => document.querySelector("#lightbox").hidden),
  "灯箱：Esc 可以关闭",
);
await page.screenshot({ path: path.join(SHOT_DIR, "gallery.png") });

const beforeUpload = await page.evaluate(() => document.querySelectorAll(".gallery__item").length);
const input = await page.$("#fileInput");
await input.uploadFile(SAMPLE_PHOTO);
await page
  .waitForFunction('document.querySelectorAll(".queue__item").length === 1', { timeout: 15000 })
  .catch(() => {});
expect(
  await page.evaluate(() => document.querySelectorAll(".queue__item").length === 1),
  "上传：选择文件后进入队列",
);
await page
  .waitForFunction('!document.querySelector("#submitBtn").disabled', { timeout: 15000 })
  .catch(() => {});

await page.click("#submitBtn");
await page
  .waitForFunction(
    () => {
      const status = document.querySelector("#formStatus");
      return !status.hidden && status.textContent.includes("已上传");
    },
    { timeout: 30000 },
  )
  .catch(() => {});
const uploadStatus = await page.evaluate(
  () => document.querySelector("#formStatus").textContent.trim(),
);
const afterUpload = await page.evaluate(() => document.querySelectorAll(".gallery__item").length);
expect(uploadStatus.includes("已上传"), `上传：提交成功（${uploadStatus}）`);
expect(afterUpload > beforeUpload, `上传：相册从 ${beforeUpload} 增至 ${afterUpload} 张`);
await page.screenshot({ path: path.join(SHOT_DIR, "upload.png") });

await page.click('.segmented button[data-filter="community"]');
await new Promise((resolve) => setTimeout(resolve, 500));
const communityCount = await page.evaluate(() => document.querySelectorAll(".gallery__item").length);
expect(communityCount >= 1, `筛选：只看“大家上传”时有 ${communityCount} 张`);
expect(
  interactionErrors.length === 0,
  `交互过程无脚本错误 ${JSON.stringify(interactionErrors.slice(0, 2))}`,
);

// ---- 移动端导航面板 ----
const mobile = await browser.newPage();
await mobile.setViewport({ width: 390, height: 844, isMobile: true });
await mobile.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
await mobile.click(".nav__toggle");
await new Promise((resolve) => setTimeout(resolve, 300));
const panelOpen = await mobile.evaluate(() => ({
  expanded: document.querySelector(".nav__toggle").getAttribute("aria-expanded"),
  hidden: document.querySelector("#navPanel").hidden,
  panelRect: document.querySelector("#navPanel").getBoundingClientRect().height,
}));
expect(panelOpen.expanded === "true" && !panelOpen.hidden, "移动端导航：点击后展开");
await mobile.click('#navPanel a[href="#gallery"]');
await new Promise((resolve) => setTimeout(resolve, 400));
const panelClosed = await mobile.evaluate(() => ({
  hidden: document.querySelector("#navPanel").hidden,
  scrolled: Math.round(window.scrollY),
}));
expect(panelClosed.hidden, "移动端导航：点链接后收起");
expect(panelClosed.scrolled > 100, `移动端导航：锚点跳转生效 (scrollY=${panelClosed.scrolled})`);
await mobile.screenshot({ path: path.join(SHOT_DIR, "mobile-gallery.png") });
await mobile.close();

await page.close();
await browser.close();

console.log(`\n通过 ${passes.length} 项：`);
passes.forEach((line) => console.log(`  ok  ${line}`));
if (problems.length) {
  console.log(`\n需要关注 ${problems.length} 项：`);
  problems.forEach((line) => console.log(`  !!  ${line}`));
} else {
  console.log("\n全部检查通过。");
}
console.log(`\n截图目录：${SHOT_DIR}`);

process.exit(problems.length ? 1 : 0);

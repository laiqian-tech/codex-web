// Mobile-viewport smoke check for the Codex Web client.
// Usage: BASE_URL=http://127.0.0.1:5173 node scripts/mobile-check.mjs
// Requires Playwright + a Chromium (CI: `npx playwright install --with-deps chromium`).
// Exits non-zero if any viewport has horizontal overflow, JS errors, or a missing
// core control — so it can gate CI.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadChromium() {
  const candidates = [
    "playwright",
    "playwright-core",
    `${process.env.HOME}/node_modules/playwright`,
  ];
  for (const c of candidates) {
    try {
      return require(c).chromium;
    } catch {
      /* try next */
    }
  }
  throw new Error("Playwright not found. Run: npm i -D playwright && npx playwright install chromium");
}

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const VIEWPORTS = [
  { name: "iphone-se", width: 360, height: 780 },
  { name: "iphone-13", width: 390, height: 844 },
  { name: "pixel-7", width: 412, height: 915 },
  { name: "landscape", width: 844, height: 390 },
];

const chromium = loadChromium();
const browser = await chromium.launch();
const failures = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const report = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    overflowY: document.documentElement.scrollHeight > window.innerHeight + 1,
    hasComposer: !!document.querySelector(".composer"),
    composerVisible:
      (document.querySelector(".composer")?.getBoundingClientRect().bottom ?? Infinity) <=
      window.innerHeight + 1,
    hasMore: !!document.querySelector("#moreBtn"),
  }));

  // Soft-keyboard simulation: the visualViewport handler sets --vvh; the shell
  // must shrink with it so the composer stays above the keyboard.
  const keyboard = await page.evaluate(() => {
    document.documentElement.style.setProperty("--vvh", "500px");
    const bottom = document.querySelector(".composer").getBoundingClientRect().bottom;
    document.documentElement.style.removeProperty("--vvh");
    return { composerBottom: bottom };
  });

  // The ⋯ menu (12 items) must fit the viewport or scroll internally.
  const menu = await page.evaluate(() => {
    const m = document.querySelector("#moreMenu");
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.hidden = true;
    return { fits: r.bottom <= window.innerHeight + 1, scrollable: m.scrollHeight >= m.clientHeight };
  });

  const phone = vp.width <= 780;
  if (report.overflowX) failures.push(`${vp.name}: horizontal overflow`);
  if (report.overflowY) failures.push(`${vp.name}: vertical overflow (page scrolls)`);
  if (!report.hasComposer) failures.push(`${vp.name}: composer missing`);
  if (!report.composerVisible) failures.push(`${vp.name}: composer below the fold`);
  if (!report.hasMore) failures.push(`${vp.name}: more-menu missing`);
  if (phone && keyboard.composerBottom > 501) {
    failures.push(`${vp.name}: composer hidden behind keyboard (bottom=${keyboard.composerBottom})`);
  }
  if (!menu.fits) failures.push(`${vp.name}: more-menu overflows viewport`);
  if (jsErrors.length) failures.push(`${vp.name}: JS error ${jsErrors[0]}`);

  // On phones the drawer toggle must be visible (sidebar is off-canvas).
  if (phone) {
    const drawerVisible = await page.locator("#drawerBtn").isVisible();
    if (!drawerVisible) failures.push(`${vp.name}: drawer button hidden on phone`);
  }

  console.log(`✓ ${vp.name} (${vp.width}x${vp.height}) overflowX=${report.overflowX} errors=${jsErrors.length}`);
  await ctx.close();
}

await browser.close();

if (failures.length) {
  console.error("\n✗ Mobile check failed:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n✓ All mobile viewports passed.");

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

// The artifact host wraps the file in its own <head> before serving it. Shooting
// the bare file skips that, and without a viewport meta Chromium lays mobile out
// at 980px and scales down — which is not what anyone sees. Rebuild the skeleton.
const body = readFileSync('switchboard.html', 'utf8');
writeFileSync(
  '.shot-src.html',
  `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style>` +
    `</head><body>${body}</body></html>`,
);

const file = `file://${process.cwd()}/.shot-src.html`;

const shots = [
  { name: 'mac-properties',     width: 1680, height: 1000, scale: 2, view: 'properties' },
  { name: 'windows-properties', width: 1440, height: 860,  scale: 1, view: 'properties' },
  { name: 'mobile-properties',  width: 390,  height: 844,  scale: 2, view: 'properties', mobile: true },
  { name: 'mac-today', width: 1680, height: 1000, scale: 2, view: 'today' },
  { name: 'mobile-followups', width: 390, height: 844, scale: 2, view: 'followups', mobile: true },
  { name: 'mac-reply-queue-dark', width: 1680, height: 1000, scale: 2, view: 'replies', theme: 'dark' },
];

// Point CHROMIUM_PATH at a browser binary if Playwright's own download is not
// where it expects; otherwise let Playwright resolve it.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });
for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.scale,
    isMobile: Boolean(s.mobile),
    hasTouch: Boolean(s.mobile),
    colorScheme: s.theme ?? 'light',
  });
  const page = await ctx.newPage();
  await page.goto(file, { waitUntil: 'networkidle' });
  await page.evaluate((t) => localStorage.setItem('sb-theme', t), s.theme ?? 'light');
  await page.click(`[data-view="${s.view}"]`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `screenshots/${s.name}.png` });
  const w = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`${s.name.padEnd(18)} ${s.width}x${s.height} @${s.scale}x  layout viewport ${w}px`);
  await ctx.close();
}
await browser.close();

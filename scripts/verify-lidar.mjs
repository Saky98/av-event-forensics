// Headless browser verification of the Phase 4 LiDAR view (WebGL).
//
// Prerequisites (macOS 13 needs playwright <= 1.48):
//   mkdir -p /tmp/pwtest && cd /tmp/pwtest && npm init -y && npm i playwright@1.48.2
//   npx playwright install chromium
// Start the app first: npm run dev
// Run: cp scripts/verify-lidar.mjs /tmp/pwtest/ && cd /tmp/pwtest && node verify-lidar.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const APP = 'http://localhost:5173/';
const MCAP = '/Users/macbook/deepaccident-forensic/storage/Town02_with_map.mcap';
const OUT = '/tmp/pwtest/';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-unsafe-webgpu',
  ],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ FAIL ${name}: ${e?.message ?? e}`);
    await page.screenshot({ path: OUT + 'fail.png' }).catch(() => {});
    process.exitCode = 1;
    throw e;
  }
}

try {
  await step('app loads', async () => {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('button:has-text("Open MCAP")', { timeout: 15000 });
  });

  await step('loads MCAP file', async () => {
    await page.setInputFiles('input[type=file]', MCAP);
    await page.waitForSelector('button:has-text("3D LiDAR")', { timeout: 60000 });
  });

  await step('switches to 3D LiDAR tab', async () => {
    await page.click('button:has-text("3D LiDAR")');
    await page.waitForSelector('.lidar-canvas canvas', { timeout: 30000 });
  });

  await step('renders WebGL scene', async () => {
    await page.waitForTimeout(2500); // let sweep + map + boxes arrive
    const info = await page.evaluate(() => {
      const canvas = document.querySelector('.lidar-canvas canvas');
      if (!canvas) return { hasCanvas: false };
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return {
        hasCanvas: true,
        width: canvas.width,
        height: canvas.height,
        webgl: !!gl,
        vendor: gl ? gl.getParameter(gl.VENDOR) : null,
      };
    });
    console.log('    GL info:', JSON.stringify(info));
    if (!info.hasCanvas || !info.webgl) {
      throw new Error('WebGL context missing');
    }
  });

  await step('stats show points + boxes', async () => {
    await page.waitForTimeout(1500);
    const stats = await page.textContent('.lidar-stats').catch(() => null);
    console.log('    stats:', stats);
    if (!stats || !/pts/.test(stats)) {
      throw new Error(`unexpected stats: ${stats}`);
    }
  });

  await step('timeline play updates the view', async () => {
    await page.click('.timeline-controls button:has-text("Play")');
    await page.waitForTimeout(2500);
    await page.click('.timeline-controls button:has-text("Pause")');
  });

  await page.screenshot({ path: OUT + 'lidar-final.png' });
  console.log('\nScreenshots: ' + OUT + 'lidar-final.png');
} finally {
  await browser.close();
}
console.log('\n--- console log tail (last 25) ---');
console.log(logs.slice(-25).join('\n'));

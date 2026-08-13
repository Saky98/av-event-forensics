// Headless browser verification of the Phase 5 Telemetry panel.
// Prereqs: same as scripts/verify-lidar.mjs (playwright@1.48.2 in /tmp/pwtest, app running).
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist'] });
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
    await page.screenshot({ path: '/tmp/pwtest/telemetry-fail.png' }).catch(() => {});
    process.exitCode = 1;
    throw e;
  }
}

try {
  await step('app loads + file', async () => {
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('button:has-text("Open MCAP")', { timeout: 15000 });
    await page.setInputFiles('input[type=file]', '/Users/macbook/deepaccident-forensic/storage/Town02_with_map.mcap');
    await page.waitForSelector('button:has-text("Telemetry")', { timeout: 60000 });
  });

  await step('opens Telemetry tab', async () => {
    await page.click('button:has-text("Telemetry")');
    await page.waitForSelector('.telemetry-plot canvas', { timeout: 20000 });
    await page.waitForTimeout(1200);
  });

  await step('uPlot chart drawn with series', async () => {
    const info = await page.evaluate(() => {
      const canvas = document.querySelector('.telemetry-plot canvas');
      const legend = document.querySelector('.u-legend');
      const seriesText = legend ? legend.textContent ?? '' : '';
      return {
        hasCanvas: !!canvas,
        w: canvas?.width,
        h: canvas?.height,
        legendText: seriesText.slice(0, 200),
        seriesCount: legend ? legend.querySelectorAll('.u-series').length : 0,
      };
    });
    console.log('    chart:', JSON.stringify(info));
    if (!info.hasCanvas || !/Velocity/.test(info.legendText) || !/Acceleration/.test(info.legendText)) {
      throw new Error('velocity/acceleration series missing from legend');
    }
  });

  await step('timeline cursor moves during play', async () => {
    const read = () =>
      page.evaluate(() => ({
        left: document.querySelector('.telemetry-cursor')?.style.left ?? 'n/a',
        time: document.querySelector('.timeline-time')?.textContent ?? 'n/a',
      }));
    const a = await read();
    await page.click('.timeline-controls button:has-text("Play")');
    await page.waitForTimeout(900);
    await page.click('.timeline-controls button:has-text("Pause")');
    const b = await read();
    console.log(`    before: left=${a.left} time="${a.time}"`);
    console.log(`    after : left=${b.left} time="${b.time}"`);
    if (a.time === b.time) {
      throw new Error(`timeline time did not advance (${a.time})`);
    }
    if (a.left === b.left) {
      throw new Error(`cursor left did not change (${a.left})`);
    }
  });

  await step('click-to-seek moves timeline', async () => {
    const before = await page.evaluate(() => document.querySelector('.timeline-time')?.textContent ?? '');
    const plotBox = await page.locator('.telemetry-plot canvas').boundingBox();
    if (!plotBox) throw new Error('no plot box');
    // click near the right end of the chart
    await page.mouse.click(plotBox.x + plotBox.width * 0.85, plotBox.y + plotBox.height * 0.5);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelector('.timeline-time')?.textContent ?? '');
    console.log(`    timeline time: "${before}" -> "${after}"`);
    if (before === after) {
      throw new Error('timeline time did not change after click');
    }
  });

  await page.screenshot({ path: '/tmp/pwtest/telemetry-final.png' });
  console.log('\nScreenshot: /tmp/pwtest/telemetry-final.png');
} finally {
  await browser.close();
}
console.log('\n--- console tail (last 8) ---');
console.log(logs.filter((l) => /pageerror|\[error\]/.test(l)).slice(-8).join('\n') || '(no errors)');

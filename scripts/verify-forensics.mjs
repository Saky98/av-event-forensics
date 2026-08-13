// Headless browser verification of the Phase 6 Forensic panel.
// Prereqs: same as other verify scripts (playwright@1.48.2 in /tmp/pwtest, app running).
import { chromium } from 'playwright';

const REF_HASH = '3d9abdd8c8a86c7b37627925edadfbca2e6dfb7c72113639ee2ec768b83ce534';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

/** Badge of the LAST forensic card (the frame hash chain card). */
const chainBadge = () =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('.forensic-card')];
    const chain = cards[cards.length - 1];
    return chain?.querySelector('.forensic-badge')?.textContent ?? null;
  });

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ FAIL ${name}: ${e?.message ?? e}`);
    await page.screenshot({ path: '/tmp/pwtest/forensic-fail.png' }).catch(() => {});
    process.exitCode = 1;
    throw e;
  }
}

try {
  await step('app loads + file', async () => {
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('button:has-text("Open MCAP")', { timeout: 15000 });
    await page.setInputFiles('input[type=file]', '/Users/macbook/deepaccident-forensic/storage/Town02_with_map.mcap');
    await page.waitForSelector('button:has-text("Forensic")', { timeout: 60000 });
  });

  await step('opens Forensic tab', async () => {
    await page.click('button:has-text("Forensic")');
    await page.waitForSelector('.forensic-card', { timeout: 20000 });
  });

  await step('computed SHA-256 matches shasum reference', async () => {
    await page.waitForFunction(
      (h) => document.querySelector('.forensic-hash')?.textContent === h,
      REF_HASH,
      { timeout: 30000 },
    );
    const hash = await page.textContent('.forensic-hash');
    console.log(`    hash: ${hash}`);
    if (hash !== REF_HASH) throw new Error(`hash mismatch: ${hash}`);
  });

  await step('expected hash: correct -> INTACT, wrong -> MISMATCH', async () => {
    const input = page.locator('.forensic-input');
    await input.fill(REF_HASH);
    await page.waitForFunction(() => document.querySelector('.forensic-badge')?.textContent?.includes('INTACT'), null, { timeout: 5000 });
    console.log(`    correct hash -> "${await page.textContent('.forensic-badge')}"`);
    await input.fill('0'.repeat(64));
    await page.waitForFunction(() => document.querySelector('.forensic-badge')?.textContent?.includes('MISMATCH'), null, { timeout: 5000 });
    console.log(`    wrong hash   -> "${await page.textContent('.forensic-badge')}"`);
    await input.fill('');
  });

  await step('chain: 45 links, verify intact, tamper breaks it', async () => {
    await page.waitForFunction(() => document.querySelectorAll('.forensic-link').length === 45, null, { timeout: 15000 });
    const links = await page.evaluate(() => document.querySelectorAll('.forensic-link').length);
    console.log(`    links: ${links} | badge: "${await chainBadge()}"`);
    if (!/intact/i.test((await chainBadge()) ?? '')) throw new Error('chain should be intact initially');

    await page.click('button:has-text("Simulate tamper")');
    await page.waitForFunction(async () => ((await chainBadge()) ?? '').includes('broke'), null, { timeout: 10000 });
    const badgeAfter = await chainBadge();
    console.log(`    after tamper: "${badgeAfter}"`);
    if (!/broke at link 22/.test(badgeAfter ?? '')) throw new Error(`expected 'broke at link 22', got: ${badgeAfter}`);

    const tamperedCount = await page.evaluate(() => document.querySelectorAll('.forensic-link.tampered').length);
    if (tamperedCount !== 45 - 22) throw new Error(`expected 23 tampered rows, got ${tamperedCount}`);
    console.log(`    tampered rows: ${tamperedCount} (frame 22..44)`);

    await page.click('button:has-text("Reset")');
    await page.waitForFunction(async () => ((await chainBadge()) ?? '').includes('intact'), null, { timeout: 5000 });
    console.log('    after reset: intact ✓');
  });

  await page.screenshot({ path: '/tmp/pwtest/forensic-final.png' });
  console.log('\nScreenshot: /tmp/pwtest/forensic-final.png');
} finally {
  await browser.close();
}
const realErrors = logs.filter((l) => l.startsWith('[pageerror]'));
console.log('\npageerrors:', realErrors.length === 0 ? 'none' : realErrors.join(' | '));

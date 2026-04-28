/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

async function clickIfVisibleInAnyFrame(page, selector, timeout = 3000) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible({ timeout })) {
        await locator.click({ timeout, force: true });
        return true;
      }
    } catch {
      // Ignore and continue with next frame.
    }
  }
  return false;
}

async function run() {
  const baseUrl = process.env.MIRION_BASE_URL || 'https://sandbox.storefront.miriontest.net';
  const username = process.env.BASIC_AUTH_USERNAME || process.env.USERNAME_IAP || 'apply-mirion';
  const password =
    process.env.BASIC_AUTH_PASSWORD || process.env.PASSWORD_IAP || 'ApplyDigitalMirion2025';
  const outputPath =
    process.env.PLAYWRIGHT_STORAGE_STATE ||
    path.join(process.cwd(), 'playwright', '.auth', 'cookie-consent-state.json');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    httpCredentials: { username, password },
  });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });

  // The consent flow can show in multiple steps and iframes.
  for (let i = 0; i < 8; i += 1) {
    let clickedSomething = false;

    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("Accept All")', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("Allow All")', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, '#onetrust-accept-btn-handler', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("Submit Preferences")', 1200)) ||
      clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("Confirm My Choices")', 1200)) ||
      clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("CLOSE")', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button:has-text("Close")', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, 'button[aria-label*="close" i]', 1200)) || clickedSomething;
    clickedSomething =
      (await clickIfVisibleInAnyFrame(page, '[data-testid="close-icon"]', 1200)) || clickedSomething;

    await page.keyboard.press('Escape').catch(() => undefined);

    if (!clickedSomething) {
      break;
    }

    await page.waitForTimeout(500);
  }

  await context.storageState({ path: outputPath });
  await browser.close();

  console.log(`Saved consent storage state at: ${outputPath}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

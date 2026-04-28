/**
 * Test-coverage survey runner.
 *
 * NOT a real assertion test. Authenticates once via the magic-link flow and
 * walks through each storefront area listed in the QA checklist, dumping a
 * full-page screenshot and a JSON snapshot of useful selectors/data into
 * `survey-output/`. The artifacts feed `docs/test-coverage-survey.md`.
 *
 * Run with: `npm run prepare:consent && npx playwright test tests/_survey.spec.ts --project=chromium`
 */

import { test, expect, type Page } from '@playwright/test';
import MailSlurp, { WaitForLatestEmailSortEnum } from 'mailslurp-client';
import fs from 'fs';
import path from 'path';

test.setTimeout(600000);

const OUTPUT_DIR = path.resolve(__dirname, '..', 'survey-output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const envPrefix = process.env.NODE_ENV ?? '';
const normalizedPrefix =
  envPrefix.length > 0 && !envPrefix.endsWith('.') ? `${envPrefix}.` : envPrefix;

const BASE_URL =
  process.env.MIRION_BASE_URL ??
  `https://${normalizedPrefix}sandbox.storefront.miriontest.net`;

const BASIC_AUTH = {
  username: process.env.BASIC_AUTH_USERNAME ?? process.env.USERNAME_IAP ?? 'apply-mirion',
  password: process.env.BASIC_AUTH_PASSWORD ?? process.env.PASSWORD_IAP ?? 'ApplyDigitalMirion2025',
};

const MAILSLURP = {
  apiKey: process.env.MAILSLURP_API_KEY!,
  inboxId: process.env.MAILSLURP_INBOX_ID!,
  loginEmail:
    process.env.MIRION_LOGIN_EMAIL ?? process.env.MAILSLURP_INBOX_EMAIL_ADDRESS!,
};

test.use({
  httpCredentials: BASIC_AUTH,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
});

function extractMagicLink(emailBody: string): string | null {
  const decoded = emailBody.replaceAll('&amp;', '&');
  const match = decoded.match(/https:\/\/test\.stytch\.com\/v1\/magic_links\/redirect[^\s"'<>)]+/);
  return match?.[0] ?? null;
}

async function dismissCookies(page: Page): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const acceptBtn = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first();
    if (await acceptBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await acceptBtn.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      break;
    }
    await page.waitForTimeout(500);
  }
}

async function snapshot(page: Page, slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const dom = await page
    .evaluate(() => {
      const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));
      const sample = (els: Element[], n = 5) =>
        els.slice(0, n).map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
          dataId: el.getAttribute('data-id') || undefined,
          dataTestid: el.getAttribute('data-testid') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
          href: (el as HTMLAnchorElement).href || undefined,
        }));

      return {
        h1: $$('h1').map((el) => (el.textContent || '').trim()).slice(0, 4),
        nav: sample($$('header nav a, header a[href], [role="navigation"] a'), 30),
        buttons: sample($$('button[data-id], button[data-testid]'), 30),
        inputs: sample($$('input[id], input[name]'), 20),
        productCards: sample($$('[data-testid*="product" i], [class*="product-card" i], a[href*="/p/"], a[href*="/product/"]'), 10),
        dataTestids: Array.from(new Set($$('[data-testid]').map((el) => el.getAttribute('data-testid')).filter(Boolean))).slice(0, 60),
        externalLinks: sample($$('a[target="_blank"]'), 10),
        forms: sample($$('form'), 5),
        bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
      };
    })
    .catch((err) => ({ error: String(err) }));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${slug}.json`),
    JSON.stringify({ url, title, ...extra, dom }, null, 2),
  );
  await page
    .screenshot({ path: path.join(OUTPUT_DIR, `${slug}.png`), fullPage: true })
    .catch(() => undefined);
  console.log(`[survey] ${slug} → ${url}`);
}

test('survey: walk authenticated storefront and dump selectors', async ({ page }) => {
  const since = new Date();

  await test.step('Authenticate via magic link', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.locator('#email-input').fill(MAILSLURP.loginEmail);
    await page.locator('#submit').click();
    await expect(page.getByText('Check your email')).toBeVisible({ timeout: 20000 });

    const ms = new MailSlurp({ apiKey: MAILSLURP.apiKey });
    const latest = await ms.waitController.waitForLatestEmail({
      inboxId: MAILSLURP.inboxId,
      timeout: 240000,
      since,
      sort: WaitForLatestEmailSortEnum.DESC,
      unreadOnly: false,
      delay: 2000,
    });
    const full = await ms.emailController.getEmail({ emailId: latest.id! });
    const link = extractMagicLink(full.body ?? '');
    expect(link).not.toBeNull();

    await page.goto(link!, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(10000);
    await dismissCookies(page);
    console.log(`[survey] authenticated → ${page.url()}`);
  });

  // Helper that visits a path, lets the SPA settle and snapshots.
  const visit = async (slug: string, urlPath: string, extra?: Record<string, unknown>) => {
    await page.goto(`${BASE_URL}${urlPath}`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    await snapshot(page, slug, { requestedPath: urlPath, ...extra });
  };

  await test.step('Home (Tech) + nav probes', async () => {
    await visit('00-home-technologies', '/technologies');
    await visit('01-listing', '/listing');
  });

  await test.step('PLP probes (try category + product list URLs)', async () => {
    // Try a few common storefront patterns; the snapshot will tell us which exists.
    const pathsToProbe = [
      '/technologies/all',
      '/technologies/products',
      '/technologies/category/all',
      '/technologies?category=all',
    ];
    for (const p of pathsToProbe) {
      const slug = `02-plp-probe-${p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
      await visit(slug, p);
    }
  });

  await test.step('Discover navigation menu items', async () => {
    // Hover/expand top nav. Capture menu structure.
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.waitForTimeout(2000);

    const menuTriggers = await page
      .locator('header button, header [role="button"], header a[aria-haspopup]')
      .all();
    const triggerInfo: Array<{ text: string; opened: boolean }> = [];
    for (const trigger of menuTriggers.slice(0, 8)) {
      const text = ((await trigger.textContent().catch(() => '')) ?? '').trim().slice(0, 40);
      try {
        await trigger.hover({ timeout: 1500 });
        await page.waitForTimeout(700);
        triggerInfo.push({ text, opened: true });
      } catch {
        triggerInfo.push({ text, opened: false });
      }
    }
    await snapshot(page, '03-nav-menu', { menuTriggers: triggerInfo });
  });

  await test.step('Cart page', async () => {
    await visit('10-cart', '/cart');
  });

  await test.step('Checkout page', async () => {
    await visit('11-checkout', '/checkout');
  });

  await test.step('Quotes / Orders', async () => {
    await visit('20-quotes', '/quotes');
    await visit('21-orders', '/orders');
    await visit('22-online-orders', '/online-orders');
    await visit('23-online-quotes', '/online-quotes');
  });

  await test.step('Search', async () => {
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.waitForTimeout(2000);
    const searchTrigger = page
      .locator(
        'button[aria-label*="search" i], [data-testid*="search" i], input[type="search"], [aria-label="Search"]',
      )
      .first();
    if (await searchTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchTrigger.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1500);
    }
    await snapshot(page, '30-search', {});
  });

  await test.step('Open the first product (PDP)', async () => {
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(2000);

    const productLink = page
      .locator('a[href*="/p/"], a[href*="/product/"], a[href*="/products/"]')
      .first();
    if (await productLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await productLink.getAttribute('href').catch(() => null);
      console.log(`[survey] navigating to first product: ${href}`);
      await productLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
      await snapshot(page, '40-pdp', { followedHref: href });
    } else {
      await snapshot(page, '40-pdp-not-found', {
        note: 'No product link found on the PLP root; PDP exploration skipped.',
      });
    }
  });

  await test.step('Footer probe', async () => {
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(1500);
    await snapshot(page, '50-footer', {});
  });

  await test.step('Request access page', async () => {
    await page.goto(`${BASE_URL}/request-access`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await dismissCookies(page);
    await page.waitForTimeout(2000);
    await snapshot(page, '60-request-access', {});
  });
});

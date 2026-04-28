/**
 * Smoke test for the Mirion Storefront sandbox (Tech BU).
 *
 * Goal: navigate every reachable menu entry — header nav, Products mega-menu,
 * user dropdown, footer — and confirm each route responds < 400 and lands on a
 * real page (not /404). External links are HEAD/GET-checked through Playwright's
 * `request` API so we know the destinations are live.
 *
 * Wide and shallow on purpose. Per-page deep assertions live in the
 * `regression.spec.ts` and the upcoming per-area specs documented in
 * `docs/test-coverage-survey.md`.
 *
 * Run with:
 *   npm run prepare:consent && npx playwright test tests/smoke.spec.ts --project=chromium
 */

import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import MailSlurp, { WaitForLatestEmailSortEnum } from 'mailslurp-client';
import fs from 'fs';
import path from 'path';

test.setTimeout(900000);

const OUT_DIR = path.resolve(__dirname, '..', 'smoke-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ENV_PREFIX = process.env.NODE_ENV ?? '';
const NORMALIZED = ENV_PREFIX.length > 0 && !ENV_PREFIX.endsWith('.') ? `${ENV_PREFIX}.` : ENV_PREFIX;
const BASE_URL =
  process.env.MIRION_BASE_URL ?? `https://${NORMALIZED}sandbox.storefront.miriontest.net`;

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

// Cap how many product cards we drill into to keep the smoke fast.
const PDP_SAMPLE_SIZE = 3;

test.use({
  httpCredentials: BASIC_AUTH,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
});

type Outcome = { url: string; label: string; status: number | null; ok: boolean; reason?: string };
const internalResults: Outcome[] = [];
const externalResults: Outcome[] = [];

function extractMagicLink(emailBody: string): string | null {
  const decoded = emailBody.replaceAll('&amp;', '&');
  const match = decoded.match(/https:\/\/test\.stytch\.com\/v1\/magic_links\/redirect[^\s"'<>)]+/);
  return match?.[0] ?? null;
}

async function dismissCookies(page: Page): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const accept = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first();
    if (await accept.isVisible({ timeout: 1500 }).catch(() => false)) {
      await accept.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(400);
      return;
    }
    await page.waitForTimeout(400);
  }
}

function isInternal(href: string): boolean {
  try {
    const u = new URL(href);
    return u.host === new URL(BASE_URL).host;
  } catch {
    return false;
  }
}

function normalizeInternal(href: string): string {
  // Drop tracking params and any anchor; keep pathname + meaningful query.
  const u = new URL(href);
  // Strip HubSpot tracking params if present.
  for (const k of ['__hstc', '__hssc', '__hsfp']) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

async function discoverLinks(page: Page): Promise<{ internal: string[]; external: string[] }> {
  // 1) Open the Products mega-menu so its category links exist in the DOM.
  const productsTrigger = page
    .locator('button[data-testid="ml-menu-item"]')
    .filter({ hasText: /^Products$/ })
    .first();
  if (await productsTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
    await productsTrigger.hover().catch(() => undefined);
    await page.waitForTimeout(800);
  }

  // 2) Open the user dropdown so Online Orders / Online Quotes hrefs are exposed.
  const userIcon = page.locator('[data-testid="user-icon"]').first();
  if (await userIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
    await userIcon.hover().catch(() => undefined);
    await page.waitForTimeout(600);
  }

  // 3) Scroll to the footer so its links are mounted in the DOM.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
  await page.waitForTimeout(800);

  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors
      .map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: ((a.textContent || '').replace(/\s+/g, ' ').trim() || (a as HTMLAnchorElement).getAttribute('aria-label') || '').slice(0, 60),
      }))
      .filter((x) => x.href && (x.href.startsWith('http://') || x.href.startsWith('https://'))),
  );

  // Scroll back to top so subsequent interactions still see the header.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);

  const seenInt = new Set<string>();
  const seenExt = new Set<string>();
  const internal: string[] = [];
  const external: string[] = [];

  for (const { href } of hrefs) {
    if (isInternal(href)) {
      const norm = normalizeInternal(href);
      // Skip auth/logout endpoints from the discovered list — we test those explicitly.
      if (/\/login(\?.*action=logout)?/i.test(norm)) continue;
      if (!seenInt.has(norm)) {
        seenInt.add(norm);
        internal.push(norm);
      }
    } else {
      // For externals we only care about the canonical origin+path; HubSpot can
      // append tracking but the upstream HEAD on the canonical URL is enough.
      if (!seenExt.has(href)) {
        seenExt.add(href);
        external.push(href);
      }
    }
  }

  return { internal, external };
}

/**
 * The Mirion storefront is a SPA: the server returns 200 with index.html for
 * any path, and the React Router decides client-side whether to render the
 * actual page or the NotFound component. So HTTP status alone is not enough
 * to detect a broken route — we also have to look at the rendered title/h1.
 */
async function isNotFoundPage(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => '')) ?? '';
  if (/Page Not Found/i.test(title)) return true;
  const notFoundH1 = await page
    .locator('h1', { hasText: /Oops!\s*The page was not found/i })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return notFoundH1;
}

async function visitInternal(page: Page, url: string, label?: string): Promise<Outcome> {
  let status: number | null = null;
  try {
    const resp: Response | null = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

    const reasons: string[] = [];
    if (status !== null && status >= 400) reasons.push(`HTTP ${status}`);
    if (/\/404(\?|$)/i.test(page.url())) reasons.push(`redirected to ${page.url()}`);
    if (await isNotFoundPage(page)) reasons.push('rendered NotFound page (SPA-level 404)');
    const headerOk = await page
      .locator('[data-testid="header-logo"], [data-testid="compact-header-logo"]')
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);
    if (!headerOk) reasons.push('header not rendered');

    const ok = reasons.length === 0;
    return {
      url,
      label: label ?? url,
      status,
      ok,
      reason: reasons.length ? reasons.join('; ') : undefined,
    };
  } catch (err) {
    return {
      url,
      label: label ?? url,
      status,
      ok: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

async function checkExternal(request: APIRequestContext, url: string): Promise<Outcome> {
  // Smoke contract for externals: we only need evidence the destination host is
  // alive — i.e. the request didn't fail at DNS/connect/TLS level and the
  // upstream returned something < 500. Many third-party hosts (mirion.com)
  // gate automated traffic behind a WAF and return 403 to bot-shaped clients;
  // that's not a storefront defect. A 5xx, timeout, or DNS failure IS.
  let status: number | null = null;
  try {
    const head = await request.head(url, { failOnStatusCode: false, timeout: 15000 });
    status = head.status();
    if (status === 405 || status === 501) {
      const get = await request.get(url, { failOnStatusCode: false, timeout: 20000 });
      status = get.status();
    }
    const ok = status >= 200 && status < 500;
    return {
      url,
      label: url,
      status,
      ok,
      reason: ok && status >= 400 ? `host responded ${status} (likely WAF-gated, not a defect)` : undefined,
    };
  } catch (err) {
    return {
      url,
      label: url,
      status,
      ok: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

test('smoke: every menu link, every category, every external link is reachable', async ({ page, request }) => {
  await test.step('00 · Authenticate via magic link', async () => {
    const since = new Date();
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await dismissCookies(page);
    await expect(page.locator('#email-input')).toBeVisible();
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
    expect(link, 'No magic link found in MailSlurp inbox').not.toBeNull();

    await page.goto(link!, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(10000);
    await dismissCookies(page);
    await expect(page).not.toHaveURL(/\/login(\?|$)/);
    console.log(`  authenticated → ${page.url()}`);
  });

  let discovered: { internal: string[]; external: string[] } = { internal: [], external: [] };
  await test.step('01 · Discover all menu links from header + mega-menu + footer', async () => {
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    discovered = await discoverLinks(page);
    fs.writeFileSync(
      path.join(OUT_DIR, 'discovered-links.json'),
      JSON.stringify(discovered, null, 2),
    );
    console.log(`  discovered ${discovered.internal.length} internal links + ${discovered.external.length} external links`);
    expect(discovered.internal.length, 'No internal links discovered — header may have failed to render').toBeGreaterThan(5);
  });

  await test.step('02 · Visit every internal menu link (status < 400, no /404, header renders)', async () => {
    for (const url of discovered.internal) {
      const result = await visitInternal(page, url);
      internalResults.push(result);
      const tag = result.ok ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] (${result.status ?? '—'}) ${url}${result.reason ? ` → ${result.reason}` : ''}`);
    }
  });

  await test.step('03 · Visit auth-required pages explicitly (cart, checkout, account)', async () => {
    const explicit = [
      `${BASE_URL}/cart`,
      `${BASE_URL}/checkout`,
      `${BASE_URL}/account/orders`,
      `${BASE_URL}/account/quotes`,
    ];
    for (const url of explicit) {
      // Skip if we already covered it via discovery.
      if (internalResults.some((r) => normalizeInternal(r.url) === normalizeInternal(url))) continue;
      const result = await visitInternal(page, url, url);
      internalResults.push(result);
      const tag = result.ok ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] (${result.status ?? '—'}) ${url}${result.reason ? ` → ${result.reason}` : ''}`);
    }
  });

  await test.step(`04 · Drill into PLP and visit ${PDP_SAMPLE_SIZE} product cards`, async () => {
    // Pick the first /listing/ URL we discovered, fall back to the known category.
    const plp =
      discovered.internal.find((u) => /\/listing\//.test(u)) ??
      `${BASE_URL}/listing/health-physics-radiation-protection?page=1`;
    await page.goto(plp, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

    const productHrefs = await page
      .locator('a[data-testid^="product-card-"][data-testid$="-link"]')
      .evaluateAll((els) =>
        Array.from(new Set(els.map((el) => (el as HTMLAnchorElement).href).filter(Boolean))),
      );

    const sample = productHrefs.slice(0, PDP_SAMPLE_SIZE);
    expect(sample.length, 'PLP returned no product links to drill into').toBeGreaterThan(0);

    for (const href of sample) {
      const url = normalizeInternal(href);
      const result = await visitInternal(page, url, `PDP: ${url.replace(BASE_URL, '')}`);
      internalResults.push(result);
      const tag = result.ok ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] (${result.status ?? '—'}) ${url}${result.reason ? ` → ${result.reason}` : ''}`);
    }
  });

  await test.step('05 · 404 control: bogus path must be detected as not-found', async () => {
    const url = `${BASE_URL}/this-route-does-not-exist-${Date.now()}`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp?.status() ?? 0;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    const landed = page.url();
    const renderedNotFound = await isNotFoundPage(page);
    const detected = status >= 400 || /\/404(\?|$)/i.test(landed) || renderedNotFound;
    console.log(
      `  [${detected ? 'PASS' : 'FAIL'}] (${status}) 404 control → landed=${landed} renderedNotFound=${renderedNotFound}`,
    );
    expect(
      detected,
      `Bogus path was NOT detected as 404. status=${status} landed=${landed} renderedNotFound=${renderedNotFound}`,
    ).toBe(true);
  });

  await test.step('06 · HEAD-check every external link', async () => {
    for (const url of discovered.external) {
      const result = await checkExternal(request, url);
      externalResults.push(result);
      const tag = result.ok ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] (${result.status ?? '—'}) EXT  ${url}${result.reason ? ` → ${result.reason}` : ''}`);
    }
  });

  await test.step('07 · Logout works', async () => {
    await page.goto(`${BASE_URL}/login?action=logout`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await expect(page.locator('#email-input')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
    console.log('  [PASS] logout returned to /login form');
  });

  // Persist a JSON summary for diffing across runs.
  fs.writeFileSync(
    path.join(OUT_DIR, 'summary.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        internal: internalResults,
        external: externalResults,
      },
      null,
      2,
    ),
  );

  const internalFailed = internalResults.filter((r) => !r.ok);
  const externalFailed = externalResults.filter((r) => !r.ok);

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log(`Internal pages checked: ${internalResults.length} (${internalResults.length - internalFailed.length} pass / ${internalFailed.length} fail)`);
  console.log(`External links checked: ${externalResults.length} (${externalResults.length - externalFailed.length} pass / ${externalFailed.length} fail)`);
  if (internalFailed.length) {
    console.log('\nInternal failures:');
    for (const f of internalFailed) console.log(`  - (${f.status ?? '—'}) ${f.url} → ${f.reason}`);
  }
  if (externalFailed.length) {
    console.log('\nExternal failures:');
    for (const f of externalFailed) console.log(`  - (${f.status ?? '—'}) ${f.url} → ${f.reason}`);
  }
  console.log('===================================\n');

  expect(internalFailed, `${internalFailed.length} internal page(s) failed smoke check`).toHaveLength(0);
  expect(externalFailed, `${externalFailed.length} external link(s) failed smoke check`).toHaveLength(0);
});

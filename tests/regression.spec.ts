/**
 * Critical-flow regression for the Mirion Storefront sandbox (Tech BU).
 *
 * Authenticates once via the magic-link flow, then walks through each high-value
 * flow asserting on the selectors discovered in `docs/test-coverage-survey.md`.
 * Every flow is wrapped in `test.step()` so failures are isolated per area in the
 * Playwright HTML report. A summary log is printed at the end.
 *
 * Run with:
 *   npm run prepare:consent && npx playwright test tests/regression.spec.ts --project=chromium
 *
 * NOTE: This spec deliberately does NOT mutate state (no add-to-cart, no submit
 * order, no save-as-quote). It is a read-only smoke regression. Mutating tests
 * belong in dedicated specs with proper setup/teardown.
 */

import { test, expect, type Page } from '@playwright/test';
import MailSlurp, { WaitForLatestEmailSortEnum } from 'mailslurp-client';
import fs from 'fs';
import path from 'path';

test.setTimeout(600000);

const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'regression-output');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ENV_PREFIX = process.env.NODE_ENV ?? '';
const NORMALIZED = ENV_PREFIX.length > 0 && !ENV_PREFIX.endsWith('.') ? `${ENV_PREFIX}.` : ENV_PREFIX;

const BASE_URL =
  process.env.MIRION_BASE_URL ?? `https://${NORMALIZED}sandbox.storefront.miriontest.net`;

const MAILSLURP = {
  apiKey: process.env.MAILSLURP_API_KEY!,
  inboxId: process.env.MAILSLURP_INBOX_ID!,
  loginEmail:
    process.env.MIRION_LOGIN_EMAIL ?? process.env.MAILSLURP_INBOX_EMAIL_ADDRESS!,
};

test.use({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
});

type StepResult = { name: string; status: 'pass' | 'fail'; detail?: string };
const results: StepResult[] = [];

async function track(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    results.push({ name, status: 'fail', detail });
    console.log(`  FAIL  ${name} → ${detail}`);
    throw err;
  }
}

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

async function snap(page: Page, slug: string): Promise<void> {
  await page
    .screenshot({ path: path.join(SCREENSHOT_DIR, `${slug}.png`), fullPage: true })
    .catch(() => undefined);
}

test('regression: critical flows for the Tech BU storefront', async ({ page }) => {
  await test.step('00 · Login (magic link)', async () => {
    await track('Login: open /login form', async () => {
      const since = new Date();
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
      await dismissCookies(page);
      await expect(page.locator('#email-input')).toBeVisible();
      await expect(page.locator('#submit')).toBeVisible();

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
      await snap(page, '00-after-login');
    });
  });

  await test.step('01 · Home (/technologies)', async () => {
    await page.goto(`${BASE_URL}/technologies`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '01-home-technologies');

    await track('Home: hero banner is visible', async () => {
      await expect(page.locator('[data-testid="or-hero-banner"]').first()).toBeVisible();
    });
    await track('Home: header logo is visible', async () => {
      await expect(page.locator('[data-testid="header-logo"], [data-testid="compact-header-logo"]').first()).toBeVisible();
    });
    await track('Home: at least one Explore-by-Category card is visible', async () => {
      await expect(page.getByText(/Explore by Product Category/i).first()).toBeVisible();
    });
    await track('Home: Mirion Quality Promise CTA is external + new tab', async () => {
      const cta = page.getByRole('link', { name: /Read Quality Promise/i }).first();
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('target', '_blank');
      await expect(cta).toHaveAttribute('href', /^https:\/\/www\.mirion\.com\//);
    });
    await track('Home: Storefront FAQ CTA is external + new tab', async () => {
      const cta = page.getByRole('link', { name: /Read Storefront FAQ/i }).first();
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('target', '_blank');
    });
  });

  await test.step('02 · Top navigation', async () => {
    await track('Nav: Discover & Learn link points to mirion.com (external + new tab)', async () => {
      const link = page.locator('[data-testid="ml-menu-item"]').filter({ hasText: 'Discover & Learn' }).first();
      await expect(link).toBeVisible();
      // HubSpot tracking script can append __hstc/__hssc/__hsfp query params at
      // runtime after the cookie banner is accepted, so we assert on the prefix.
      await expect(link).toHaveAttribute('href', /^https:\/\/www\.mirion\.com\/discover(\?|$)/);
      await expect(link).toHaveAttribute('target', '_blank');
    });
    await track('Nav: Contact Us link points to mirion.com contact form', async () => {
      const link = page.locator('[data-testid="ml-menu-item"]').filter({ hasText: 'Contact Us' }).first();
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', /www\.mirion\.com\/contact/);
    });
    await track('Nav: Products mega-menu trigger is visible', async () => {
      await expect(
        page.locator('button[data-testid="ml-menu-item"]').filter({ hasText: /^Products$/ }).first(),
      ).toBeVisible();
    });
    await track('Nav: cart icon shows numeric quantity and links to /cart', async () => {
      const cartLink = page.locator('a[aria-label="My Cart"]').first();
      await expect(cartLink).toBeVisible();
      await expect(cartLink).toHaveAttribute('href', /\/cart$/);
      const qtyText = (await cartLink.textContent())?.trim() ?? '';
      expect(qtyText, `Cart count should be numeric, got "${qtyText}"`).toMatch(/^\d+$/);
    });
    await track('Nav: user dropdown reveals Online Orders / Online Quotes / Sign out', async () => {
      const userIcon = page.locator('[data-testid="user-icon"]').first();
      await userIcon.hover();
      await expect(page.locator('[data-testid="at-link"]').filter({ hasText: 'Online Orders' }).first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="at-link"]').filter({ hasText: 'Online Quotes' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Sign out/i }).first()).toBeVisible();
    });
    await snap(page, '02-nav-user-dropdown-open');
  });

  await test.step('03 · PLP (/listing/health-physics-radiation-protection)', async () => {
    await page.goto(`${BASE_URL}/listing/health-physics-radiation-protection?page=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '03-plp');

    await track('PLP: category h1 matches', async () => {
      await expect(page.getByRole('heading', { level: 1, name: /Health Physics & Radiation Protection/i }).first()).toBeVisible();
    });
    await track('PLP: product listing container is present', async () => {
      await expect(page.locator('[data-testid="product-listing"]').first()).toBeVisible();
    });
    await track('PLP: at least one product card has brand + name + image', async () => {
      const card = page.locator('[data-testid^="product-card-"][data-testid$="-link"]').first();
      await expect(card).toBeVisible();
      await expect(card.locator('[data-testid="product-name"], [data-testid="product-name-small"]').first()).toBeVisible();
      await expect(card.locator('[data-testid="product-brand"], [data-testid="product-brand-small"]').first()).toBeVisible();
      await expect(card.locator('[data-testid="at-image"]').first()).toBeVisible();
    });
    await track('PLP: results count text is visible', async () => {
      await expect(page.getByText(/Showing\s+\d+\s+-\s+\d+\s+of\s+\d+\s+results/i).first()).toBeVisible();
    });
    await track('PLP: Brand filter accordion is present (at least one visible variant)', async () => {
      // Storefront renders both a desktop sidebar and a mobile-collapse copy of
      // each filter, so we explicitly look for the visible one.
      await expect(
        page.locator('[data-testid="ml-accordion-header"]:visible').filter({ hasText: /^Brand$/ }).first(),
      ).toBeVisible();
    });
  });

  await test.step('04 · PDP (/product/ab-100)', async () => {
    await page.goto(`${BASE_URL}/product/ab-100`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '04-pdp');

    await track('PDP: page title contains product name + Mirion suffix', async () => {
      await expect(page).toHaveTitle(/AB-100.*Mirion/);
    });
    await track('PDP: breadcrumb chain has at least two links', async () => {
      await expect(page.locator('[data-testid="desktop-breadcrumb-link-0"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="desktop-breadcrumb-link-1"]').first()).toBeVisible();
    });
    await track('PDP: product details container shows price block', async () => {
      await expect(page.locator('[data-testid="or-product-details"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="product-price"]').first()).toBeVisible();
    });
    await track('PDP: SKU label is rendered', async () => {
      await expect(page.getByText(/SKU:\s*\S+/i).first()).toBeVisible();
    });
    await track('PDP: gallery main image + thumb 0 visible', async () => {
      await expect(page.locator('[data-testid="product-gallery-main-image-0"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="product-gallery-thumb-0"]').first()).toBeVisible();
    });
    await track('PDP: quantity controls (decrement + input + increment) visible', async () => {
      await expect(page.locator('[data-testid="decrement"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="current-quantity"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="increment"]').first()).toBeVisible();
    });
    await track('PDP: Add to Cart button is enabled', async () => {
      const cta = page.locator('[data-testid="add-to-cart-btn"]').first();
      await expect(cta).toBeVisible();
      await expect(cta).toBeEnabled();
    });
    await track('PDP: Description and Technical Specs accordions exist', async () => {
      await expect(
        page.locator('[data-testid="ml-accordion-header"]:visible').filter({ hasText: /^Description$/ }).first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="ml-accordion-header"]:visible').filter({ hasText: /^Technical Specs$/ }).first(),
      ).toBeVisible();
    });
    await track('PDP: Contact Support card opens external link in new tab', async () => {
      const cta = page.locator('a#customer-support-product').first();
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('target', '_blank');
      await expect(cta).toHaveAttribute('href', /www\.mirion\.com\/contact/);
    });
  });

  await test.step('05 · Cart (/cart)', async () => {
    await page.goto(`${BASE_URL}/cart`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '05-cart');

    await track('Cart: page title and h1 match', async () => {
      await expect(page).toHaveTitle(/Cart\s*\|\s*Mirion/);
      await expect(page.getByRole('heading', { level: 1, name: /Review Your Cart Details/i }).first()).toBeVisible();
    });
    await track('Cart: at least one cart-card item is visible', async () => {
      await expect(page.locator('[data-testid="cart-card-0"]').first()).toBeVisible();
    });
    await track('Cart: each line item has delete + qty controls', async () => {
      await expect(page.locator('[data-testid="delete-item-button"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="decrement"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="increment"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="current-quantity"]').first()).toBeVisible();
    });
    await track('Cart: order summary is visible', async () => {
      await expect(page.locator('[data-testid="or-order-summary"]').first()).toBeVisible();
    });
    await track('Cart: order summary ZIP-code control is visible', async () => {
      await expect(page.locator('[data-testid="or-order-summary-zip-code"]').first()).toBeVisible();
    });
    await track('Cart: promo-code Apply button is visible', async () => {
      await expect(page.locator('[data-testid="at-button"]').filter({ hasText: /^Apply$/ }).first()).toBeVisible();
    });
    await track('Cart: Save as Quote button is visible', async () => {
      await expect(page.locator('[data-testid="at-button"]').filter({ hasText: /Save as Quote/i }).first()).toBeVisible();
    });
    await track('Cart: Mirion Quality Promise disclaimer is visible', async () => {
      await expect(page.locator('[data-testid="ml-disclaimer"], [data-testid="ml-disclaimer-title"]').first()).toBeVisible();
    });
    await track('Cart: Contact Support card opens in new tab', async () => {
      const cta = page.locator('a#customer-support-cart').first();
      if (await cta.count()) {
        await expect(cta).toHaveAttribute('target', '_blank');
      } else {
        // Fallback: text-based locator (the id might be conditional on layout).
        const fallback = page.getByRole('link', { name: /Contact Support/i }).first();
        await expect(fallback).toHaveAttribute('target', '_blank');
      }
    });
  });

  await test.step('06 · Checkout (/checkout)', async () => {
    await page.goto(`${BASE_URL}/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '06-checkout');

    await track('Checkout: page title is Checkout | Mirion', async () => {
      await expect(page).toHaveTitle(/Checkout\s*\|\s*Mirion/);
    });
    await track('Checkout: shipping info block 0 is visible', async () => {
      await expect(page.locator('[data-testid="shipping-info-title-0"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="shipping-info-content-0"]').first()).toBeVisible();
    });
    await track('Checkout: order product list (table) is visible', async () => {
      await expect(page.locator('[data-testid="or-order-product-list"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="product-table"]').first()).toBeVisible();
    });
    await track('Checkout: purchase summary + order total visible', async () => {
      await expect(page.locator('[data-testid="or-purchase-summary"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="ml-order-total"]').first()).toBeVisible();
    });
    await track('Checkout: Submit Order button is rendered', async () => {
      await expect(page.locator('[data-testid="submit-order"]').first()).toBeVisible();
    });
    await track('Checkout: Terms-and-conditions checkbox is rendered', async () => {
      await expect(page.locator('[data-testid="tac-checkbox"]').first()).toBeAttached();
    });
    await track('Checkout: Add new shipping address control is visible', async () => {
      await expect(page.locator('[data-testid="edit-button-100"]').first()).toBeVisible();
    });
  });

  await test.step('07 · Account: Online Orders (/account/orders)', async () => {
    const resp = await page.goto(`${BASE_URL}/account/orders`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '07-account-orders');

    await track('Orders: page responds 2xx (not 404)', async () => {
      expect(resp?.status() ?? 0, 'HTTP status').toBeLessThan(400);
      await expect(page).not.toHaveURL(/\/404$/);
    });
    await track('Orders: page header / orders surface is visible', async () => {
      const title = page.getByRole('heading', { name: /Online Orders|Orders/i }).first();
      await expect(title).toBeVisible({ timeout: 15000 });
    });
  });

  await test.step('08 · Account: Online Quotes (/account/quotes)', async () => {
    const resp = await page.goto(`${BASE_URL}/account/quotes`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
    await snap(page, '08-account-quotes');

    await track('Quotes: page responds 2xx (not 404)', async () => {
      expect(resp?.status() ?? 0, 'HTTP status').toBeLessThan(400);
      await expect(page).not.toHaveURL(/\/404$/);
    });
    await track('Quotes: page header / quotes surface is visible', async () => {
      const title = page.getByRole('heading', { name: /Online Quotes|Quotes/i }).first();
      await expect(title).toBeVisible({ timeout: 15000 });
    });
  });

  await test.step('09 · Logout (/login?action=logout)', async () => {
    await page.goto(`${BASE_URL}/login?action=logout`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await snap(page, '09-after-logout');

    await track('Logout: lands on /login form (unauthenticated)', async () => {
      await expect(page).toHaveURL(/\/login/);
      await expect(page.locator('#email-input')).toBeVisible({ timeout: 10000 });
    });
  });

  // Persist a JSON summary so it can be diffed run-over-run.
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, 'summary.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
  );

  const failed = results.filter((r) => r.status === 'fail');
  console.log('\n========== REGRESSION SUMMARY ==========');
  console.log(`Total checks: ${results.length}`);
  console.log(`Passed:       ${results.length - failed.length}`);
  console.log(`Failed:       ${failed.length}`);
  if (failed.length) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log('========================================\n');

  expect(failed, `${failed.length} regression check(s) failed`).toHaveLength(0);
});

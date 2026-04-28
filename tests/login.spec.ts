import { test, expect, type Frame, type Page } from '@playwright/test';
import MailSlurp, { WaitForLatestEmailSortEnum } from 'mailslurp-client';

// 5 minutes: covers the ~2 min Mirion → Stytch → SendGrid → MailSlurp delivery
// path plus our anti-bot waits and storefront navigation.
test.setTimeout(300000);

const envPrefix = process.env.NODE_ENV ?? '';
const normalizedPrefix =
  envPrefix.length > 0 && !envPrefix.endsWith('.') ? `${envPrefix}.` : envPrefix;

const BASIC_AUTH = {
  username: process.env.BASIC_AUTH_USERNAME ?? process.env.USERNAME_IAP ?? 'apply-mirion',
  password: process.env.BASIC_AUTH_PASSWORD ?? process.env.PASSWORD_IAP ?? 'ApplyDigitalMirion2025',
};

const URLS = {
  base:
    process.env.MIRION_BASE_URL ??
    `https://${normalizedPrefix}sandbox.storefront.miriontest.net`,
  loginPath: '/login',
  listingPath: '/listing',
  authenticatePath: '/authenticate',
  medicalPath: '/medical',
  // Final destination validated by the magic-link test. Override per environment
  // / per allowlisted user (e.g. `/technologies` for accounts without /medical
  // permission).
  postAuthPath: process.env.MIRION_POST_AUTH_PATH ?? '/medical',
};

test.use({
  httpCredentials: BASIC_AUTH,
  // Anti-detection: pose as a real desktop Chrome session so MailSlurp's
  // Cloudflare layer doesn't flag the webmail login flow as automation.
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  deviceScaleFactor: 1,
  hasTouch: false,
  isMobile: false,
});

const MAILSLURP_CONFIG = {
  apiKey: process.env.MAILSLURP_API_KEY,
  inboxId: process.env.MAILSLURP_INBOX_ID,
  loginEmail: process.env.MIRION_LOGIN_EMAIL ?? process.env.MAILSLURP_INBOX_EMAIL_ADDRESS,
  manualMagicLink: process.env.MIRION_MAGIC_LINK,
  webEmail: process.env.MAILSLURP_WEB_EMAIL,
  webPassword: process.env.MAILSLURP_WEB_PASSWORD,
  webUrl: process.env.MAILSLURP_WEB_URL ?? 'https://app.mailslurp.com/login',
  forceWebmail: process.env.MAILSLURP_FORCE_WEBMAIL === 'true',
  timeoutMs: Number(process.env.MAILSLURP_TIMEOUT_MS ?? 240000),
};

function extractMagicLink(emailBody: string): string | null {
  const decodedBody = emailBody.replaceAll('&amp;', '&');
  const match = decodedBody.match(/https:\/\/test\.stytch\.com\/v1\/magic_links\/redirect[^\s"'<>)]+/);
  return match?.[0] ?? null;
}

function getScopes(page: Page): Array<Page | Frame> {
  return [page, ...page.frames()];
}

async function clickFirstVisible(page: Page, selectors: string[], timeoutMs = 1200): Promise<boolean> {
  for (const scope of getScopes(page)) {
    for (const selector of selectors) {
      const candidate = scope.locator(selector).first();
      if (await candidate.isVisible({ timeout: timeoutMs }).catch(() => false)) {
        await candidate.click({ timeout: timeoutMs, force: true }).catch(() => undefined);
        return true;
      }
    }
  }
  return false;
}

async function hasVisibleSelector(page: Page, selectors: string[], timeoutMs = 300): Promise<boolean> {
  for (const scope of getScopes(page)) {
    for (const selector of selectors) {
      const visible = await scope
        .locator(selector)
        .first()
        .isVisible({ timeout: timeoutMs })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }
  }
  return false;
}

async function dismissOverlaysAndCookieBanners(page: Page): Promise<void> {
  const acceptSelectors = [
    'button:has-text("Accept All")',
    'button:has-text("Allow All")',
    '#onetrust-accept-btn-handler',
    'button[aria-label*="Accept All" i]',
    'button[aria-label*="Allow All" i]',
  ];
  const dismissSelectors = [
    'button:has-text("Submit Preferences")',
    'button:has-text("Confirm My Choices")',
    'button:has-text("CLOSE")',
    'button:has-text("Close")',
    'button[aria-label*="close" i]',
    '[data-testid="close-icon"]',
  ];
  const blockerSelectors = [
    'text=Settings Submitted',
    'text=Cookie Preferences',
    'text=Privacy Policy',
    '[role="dialog"]',
  ];

  // Consent UI can switch steps and render inside iframes.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const accepted = await clickFirstVisible(page, acceptSelectors);
    const dismissed = await clickFirstVisible(page, dismissSelectors);
    await page.keyboard.press('Escape').catch(() => undefined);

    const stillBlocked = await hasVisibleSelector(page, blockerSelectors);
    if (!accepted && !dismissed && !stillBlocked) {
      break;
    }

    await page.waitForTimeout(500);
  }
}

async function navigateAndPrepare(
  page: Page,
  url: string,
  waitUntil: 'domcontentloaded' | 'networkidle' = 'domcontentloaded',
): Promise<void> {
  await page.goto(url, { waitUntil });
  await dismissOverlaysAndCookieBanners(page);
}

async function waitForRecentMagicLink(
  mailslurp: MailSlurp,
  inboxId: string,
  since: Date,
  timeoutMs: number,
): Promise<string | null> {
  // Server-side long-polling: blocks until an email with `createdAt >= since`
  // arrives (Mirion → Stytch → SendGrid → MailSlurp can take several minutes).
  // This is more responsive than client-side polling and avoids races where
  // the inbox returns a stale cached state.
  try {
    const latest = await mailslurp.waitController.waitForLatestEmail({
      inboxId,
      timeout: timeoutMs,
      since,
      sort: WaitForLatestEmailSortEnum.DESC,
      unreadOnly: false,
      delay: 2000,
    });

    if (!latest?.id) return null;

    const fullEmail = await mailslurp.emailController.getEmail({ emailId: latest.id });
    return extractMagicLink(fullEmail.body ?? '');
  } catch {
    return null;
  }
}

// Patches the most common automation fingerprints that anti-bot layers
// (Cloudflare, DataDome, etc.) check for. Must run before any navigation.
async function applyStealthPatches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters);

    // @ts-expect-error - real Chrome exposes a `chrome` global; headless does not
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  });
}

async function waitForMagicLinkViaWebmail(
  page: Page,
  mailboxEmail: string,
  webEmail: string,
  webPassword: string,
  timeoutMs: number,
): Promise<string | null> {
  const inboxPage = await page.context().newPage();
  await applyStealthPatches(inboxPage);

  try {
    await inboxPage.goto(MAILSLURP_CONFIG.webUrl, { waitUntil: 'domcontentloaded' });
    // Vue SPA hydrates after DOMContentLoaded; wait for network to settle so
    // tab click handlers are bound before we interact.
    await inboxPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

    // MailSlurp's login UI defaults to "Email link" (passwordless). Force the
    // "Password" tab so the password field is rendered. Try a real click first,
    // then fall back to a programmatic click if the SPA didn't react.
    const passwordTab = inboxPage.getByRole('tab', { name: /^Password$/ });
    await passwordTab.waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined);

    const ensurePasswordTabActive = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const isActive = await passwordTab.getAttribute('aria-selected').catch(() => null);
        if (isActive === 'true') return true;

        if (attempt < 2) {
          await passwordTab
            .click({ timeout: 5000, force: attempt === 1 })
            .catch(() => undefined);
        } else {
          // Last-resort: dispatch a click directly on the DOM node so we
          // bypass any pointer-event interception (reCAPTCHA, overlays, etc.).
          await inboxPage
            .evaluate(() => {
              const tab = Array.from(
                document.querySelectorAll('button[role="tab"], [role="tab"]'),
              ).find((el) => /^\s*Password\s*$/i.test(el.textContent ?? ''));
              (tab as HTMLElement | undefined)?.click();
            })
            .catch(() => undefined);
        }

        await inboxPage.waitForTimeout(500 + Math.random() * 300);
      }
      return (await passwordTab.getAttribute('aria-selected').catch(() => null)) === 'true';
    };

    if (!(await ensurePasswordTabActive())) {
      throw new Error('Could not switch MailSlurp login form to "Password" mode.');
    }

    const emailInput = inboxPage
      .locator('input#email, input[type="email"], input[name*="email" i]')
      .first();
    const passwordInput = inboxPage
      .locator('input#password, input[type="password"], input[name*="password" i]')
      .first();

    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });

    // Humanize input: real users click, pause, then type one key at a time.
    await emailInput.click({ timeout: 15000 });
    await inboxPage.waitForTimeout(300 + Math.random() * 400);
    await emailInput.pressSequentially(webEmail, { delay: 80 + Math.random() * 60 });

    await inboxPage.waitForTimeout(500 + Math.random() * 500);

    await passwordInput.click({ timeout: 15000 });
    await inboxPage.waitForTimeout(200 + Math.random() * 300);
    await passwordInput.pressSequentially(webPassword, { delay: 80 + Math.random() * 60 });

    await inboxPage.waitForTimeout(800 + Math.random() * 700);

    // `data-id="card-page-submit"` is MailSlurp's stable hook for the form's
    // primary CTA. We avoid `:has-text("Login")` because it would match the
    // "Login with Google/Microsoft/GitHub" SSO buttons rendered above the form.
    const signInButton = inboxPage.locator('button[data-id="card-page-submit"]').first();
    await signInButton.click({ timeout: 15000 });

    // Give MailSlurp time to navigate after submit (reCAPTCHA + redirect).
    await inboxPage
      .waitForURL((url) => !/\/login(\/|$|\?)/.test(url.pathname), { timeout: 20000 })
      .catch(() => undefined);
    await inboxPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);

    // Detect the explicit "User not found" warning so we fail fast with a
    // clear error instead of looping until the global test timeout.
    const credentialError = inboxPage.locator('text=/User not found for password/i').first();
    if (await credentialError.isVisible({ timeout: 1000 }).catch(() => false)) {
      throw new Error(
        'MailSlurp webmail rejected the credentials. Make sure MAILSLURP_WEB_EMAIL is the email ' +
          'of your MailSlurp account (the one used to register at app.mailslurp.com), not the ' +
          'temporary inbox address.',
      );
    }

    const mailboxLookup = inboxPage
      .locator('input[placeholder*="search" i], input[placeholder*="email" i], input[type="search"]')
      .first();
    if (await mailboxLookup.isVisible({ timeout: 10000 }).catch(() => false)) {
      await mailboxLookup.fill(mailboxEmail);
      await inboxPage.keyboard.press('Enter').catch(() => undefined);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const messageCandidates = [
        inboxPage.locator(`text=${mailboxEmail}`).first(),
        inboxPage.locator('text=/Mirion|magic link|sign in/i').first(),
        inboxPage.locator('[data-testid*="email"], [data-test*="email"]').first(),
      ];

      let openedMessage = false;
      for (const candidate of messageCandidates) {
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          await candidate.click({ timeout: 5000 }).catch(() => undefined);
          openedMessage = true;
          break;
        }
      }

      if (!openedMessage) {
        await inboxPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await inboxPage.waitForTimeout(2500);
        continue;
      }

      const bodyHtml = await inboxPage.content();
      const magicLink = extractMagicLink(bodyHtml);
      if (magicLink) {
        return magicLink;
      }

      await inboxPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await inboxPage.waitForTimeout(2500);
    }
  } finally {
    await inboxPage.close().catch(() => undefined);
  }

  return null;
}

async function selectOrganizationIfPrompted(page: Page): Promise<void> {
  const orgName = 'CardinalHealth Corporate Office - Medical';
  const orgOption = page.getByText(orgName, { exact: false }).first();
  const isOnAuthenticatePage = page.url().includes(URLS.authenticatePath);
  const hasOrgSelector = await page
    .getByText('Select an organization to continue', { exact: false })
    .isVisible()
    .catch(() => false);

  if (isOnAuthenticatePage || hasOrgSelector) {
    await expect(orgOption).toBeVisible({ timeout: 10000 });
    await orgOption.click();
    await page.waitForTimeout(10000);
  }
}

test('@basic-auth should reach login and redirect listing back to login', async ({ page }) => {
  const loginResponse = await page.goto(`${URLS.base}${URLS.loginPath}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissOverlaysAndCookieBanners(page);

  expect(loginResponse).not.toBeNull();
  expect(loginResponse?.ok()).toBeTruthy();
  await expect(page).toHaveURL(`${URLS.base}${URLS.loginPath}`);
  await expect(page.getByText('Authentication required')).toHaveCount(0);

  const listingResponse = await page.goto(`${URLS.base}${URLS.listingPath}`, { waitUntil: 'domcontentloaded' });
  await dismissOverlaysAndCookieBanners(page);

  expect(listingResponse).not.toBeNull();
  expect(listingResponse?.ok()).toBeTruthy();
  await expect(page).toHaveURL(`${URLS.base}${URLS.loginPath}`);
  await expect(page.getByText('Authentication required')).toHaveCount(0);
});

test.describe('@mailslurp login via magic link', () => {
  const canUseApi = !!MAILSLURP_CONFIG.apiKey && !!MAILSLURP_CONFIG.inboxId;
  const canUseWebmail = !!MAILSLURP_CONFIG.webEmail && !!MAILSLURP_CONFIG.webPassword;

  test.skip(
    !MAILSLURP_CONFIG.loginEmail ||
      (!MAILSLURP_CONFIG.manualMagicLink && !canUseApi && !canUseWebmail),
    'Set MIRION_LOGIN_EMAIL and one option: MIRION_MAGIC_LINK or (MAILSLURP_API_KEY + MAILSLURP_INBOX_ID) or (MAILSLURP_WEB_EMAIL + MAILSLURP_WEB_PASSWORD)',
  );

  test('should authenticate with magic link received by email', async ({ page }) => {
    const loginRequestStartedAt = new Date();
    const loginEmail = MAILSLURP_CONFIG.loginEmail!;

    await test.step(`1. Open login page (${URLS.base}${URLS.loginPath})`, async () => {
      console.log(`[1/7] Opening storefront login → ${URLS.base}${URLS.loginPath}`);
      await navigateAndPrepare(page, `${URLS.base}${URLS.loginPath}`);
    });

    await test.step(`2. Request magic link for ${loginEmail}`, async () => {
      console.log(`[2/7] Filling email "${loginEmail}" and submitting magic link request`);
      await page.locator('#email-input').fill(loginEmail);
      await page.locator('#submit').click();
      await expect(page.getByText('Check your email')).toBeVisible({ timeout: 20000 });
      console.log('[2/7] Storefront confirmed email was sent ("Check your email")');
    });

    let magicLink = MAILSLURP_CONFIG.manualMagicLink ?? null;
    if (magicLink) {
      console.log('[3/7] Using manual MIRION_MAGIC_LINK (skipping inbox capture)');
    }

    await test.step('3. Wait for email and extract magic link', async () => {
      if (magicLink) return;

      if (canUseWebmail && MAILSLURP_CONFIG.forceWebmail) {
        console.log('[3/7] MAILSLURP_FORCE_WEBMAIL=true → using webmail (app.mailslurp.com UI)');
        magicLink = await waitForMagicLinkViaWebmail(
          page,
          loginEmail,
          MAILSLURP_CONFIG.webEmail!,
          MAILSLURP_CONFIG.webPassword!,
          MAILSLURP_CONFIG.timeoutMs,
        );
      }

      if (!magicLink && canUseApi) {
        console.log(
          `[3/7] Waiting for email via MailSlurp API (inboxId=${MAILSLURP_CONFIG.inboxId}, timeout=${MAILSLURP_CONFIG.timeoutMs}ms)`,
        );
        const mailslurp = new MailSlurp({ apiKey: MAILSLURP_CONFIG.apiKey! });
        magicLink = await waitForRecentMagicLink(
          mailslurp,
          MAILSLURP_CONFIG.inboxId!,
          loginRequestStartedAt,
          MAILSLURP_CONFIG.timeoutMs,
        );
      }

      if (!magicLink && canUseWebmail) {
        console.log('[3/7] API returned no magic link → falling back to webmail');
        magicLink = await waitForMagicLinkViaWebmail(
          page,
          loginEmail,
          MAILSLURP_CONFIG.webEmail!,
          MAILSLURP_CONFIG.webPassword!,
          MAILSLURP_CONFIG.timeoutMs,
        );
      }

      expect(
        magicLink,
        'Magic link not found. Configure MIRION_MAGIC_LINK, API mode (MAILSLURP_API_KEY + MAILSLURP_INBOX_ID), or webmail mode (MAILSLURP_WEB_EMAIL + MAILSLURP_WEB_PASSWORD).',
      ).not.toBeNull();

      console.log(`[3/7] Magic link captured: ${magicLink!.slice(0, 80)}...`);
    });

    await test.step('4. Open magic link and wait for Stytch redirect', async () => {
      console.log('[4/7] Opening magic link in the browser');
      await navigateAndPrepare(page, magicLink!);
      await expect(page).not.toHaveURL(/stytch\.com\/redirect-error/);

      // Stytch validates the token and redirects to the storefront. The flow
      // goes through a few async redirects (cookies, session), so we wait 10s
      // before continuing to make sure the session is fully established.
      console.log('[4/7] Waiting 10s for Stytch to finish auth and set the session');
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(10000);
      console.log(`[4/7] URL after auth: ${page.url()}`);
    });

    await test.step('5. Select organization (if prompted)', async () => {
      console.log('[5/7] Checking whether Mirion requested organization selection');
      await selectOrganizationIfPrompted(page);
      console.log(`[5/7] URL after selection: ${page.url()}`);
    });

    await test.step(`6. Navigate to ${URLS.postAuthPath}`, async () => {
      console.log(`[6/7] Navigating to ${URLS.base}${URLS.postAuthPath}`);
      await navigateAndPrepare(page, `${URLS.base}${URLS.postAuthPath}`);
      // Small wait so the SPA can hydrate / guard the route.
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
      console.log(`[6/7] Current URL: ${page.url()}`);
    });

    await test.step(`7. Validate access to ${URLS.postAuthPath}`, async () => {
      const currentUrl = page.url();
      const bodyText = (await page.textContent('body')) ?? '';
      const hasAccessDeniedMessage = bodyText.includes(
        'has not been granted access to the Mirion Storefront.',
      );
      const isOn404 = /\/404(\/|$|\?)/.test(currentUrl);
      const isOnLogin = currentUrl.includes(URLS.loginPath);

      if (hasAccessDeniedMessage) {
        console.log(`[7/7] FAIL: Storefront denied access for ${loginEmail}`);
        throw new Error(
          `Login email "${loginEmail}" does not have storefront access. ` +
            'Use an allowlisted email for MIRION_LOGIN_EMAIL or pass MIRION_MAGIC_LINK from an authorized mailbox.',
        );
      }

      if (isOnLogin) {
        throw new Error(
          `Session did not persist: redirected back to ${URLS.loginPath}. ` +
            'Make sure the magic link was consumed correctly and that session cookies are being accepted.',
        );
      }

      if (isOn404) {
        throw new Error(
          `Storefront returned 404 when accessing "${URLS.postAuthPath}". ` +
            `User "${loginEmail}" most likely does not have permission for that category. ` +
            'Set MIRION_POST_AUTH_PATH in .env to a route this user can reach ' +
            '(e.g. MIRION_POST_AUTH_PATH=/technologies).',
        );
      }

      await expect(page).toHaveURL(new RegExp(`${URLS.postAuthPath}(\\?|$)`));
      console.log(`[7/7] OK: Access confirmed at ${page.url()}`);
    });
  });
});

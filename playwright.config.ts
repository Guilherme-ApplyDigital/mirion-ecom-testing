import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const envPrefix = process.env.NODE_ENV ?? '';
const normalizedPrefix =
  envPrefix.length > 0 && !envPrefix.endsWith('.') ? `${envPrefix}.` : envPrefix;
const storageStatePath =
  process.env.PLAYWRIGHT_STORAGE_STATE ??
  path.resolve(__dirname, 'playwright/.auth/cookie-consent-state.json');
const hasStoredConsent = fs.existsSync(storageStatePath);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  
  use: {
    baseURL:
      process.env.MIRION_BASE_URL ??
      `https://${normalizedPrefix}sandbox.storefront.miriontest.net`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    storageState: hasStoredConsent ? storageStatePath : undefined,

    // Basic auth for the sandbox environment
    httpCredentials: {
      username: process.env.BASIC_AUTH_USERNAME ?? process.env.USERNAME_IAP ?? 'apply-mirion',
      password: process.env.BASIC_AUTH_PASSWORD ?? process.env.PASSWORD_IAP ?? 'ApplyDigitalMirion2025',
    },

    // Anti-bot detection flags. `--disable-blink-features=AutomationControlled`
    // is the most important: it removes the `navigator.webdriver` flag that
    // services like Cloudflare/MailSlurp use to fingerprint Playwright/Puppeteer.
    launchOptions: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--no-sandbox',
      ],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    }
  ],
});
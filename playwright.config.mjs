// @ts-check
/**
 * Playwright configuration (blueprint 8.2, 10.1, 10.2). Owner: lane L0.
 *
 * Projects: Chromium desktop (1280 x 800), Chromium phone (360 x 740, Android emulation), WebKit iPhone
 * emulation, and a Chromium project with WebGL disabled for the outline-mode scenarios (scenario 15).
 * The WebKit project runs in CI, or locally when CTHD_WEBKIT=1 after `npx playwright install webkit`.
 * The web server is `npm run dev` (compile, then scripts/dev/serve.mjs) at the Pages subpath.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.CTHD_PORT ?? 8080);
const BASE_URL = `http://localhost:${PORT}/pnw-tribal-dashboard/`;
const withWebKit = Boolean(process.env.CI) || process.env.CTHD_WEBKIT === '1';

/** Map specs run in every project; the no-WebGL project runs only them. */
const MAP_SPECS = /(?:^|[\\/])map[^\\/]*\.spec\.mjs$/;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /\.spec\.mjs$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-phone', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } },
    ...(withWebKit ? [{ name: 'webkit-iphone', use: { ...devices['iPhone 13'] } }] : []),
    {
      name: 'chromium-no-webgl',
      testMatch: MAP_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions: { args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] } },
    },
  ],
  webServer: {
    // `npm run dev` compiles curated data, then serves site/ (the same path a maintainer runs locally).
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

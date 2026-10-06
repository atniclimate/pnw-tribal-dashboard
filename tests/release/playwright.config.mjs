// @ts-check
import { defineConfig, devices } from '@playwright/test';

/** Production artifact checks. Serve `npm run assemble` output with `serve --root _site --port 8089`. */
export default defineConfig({
  testDir: '.',
  testMatch: /offline\.spec\.mjs$/,
  outputDir: '../../reports/release-test-results',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8089/pnw-tribal-dashboard/', serviceWorkers: 'allow', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-release', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-release', use: { ...devices['iPhone 13'] } },
  ],
});

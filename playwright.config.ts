import path from 'path'
import { defineConfig, devices } from '@playwright/test'

const outboxFile = path.resolve(__dirname, 'e2e/.outbox/emails.jsonl')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'e2e/.results',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      EMAIL_OUTBOX_FILE: outboxFile,
      SMTP_HOST: '',
    },
  },
})

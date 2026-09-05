import { test, expect } from '@playwright/test'
import { readFile, rm } from 'fs/promises'
import path from 'path'

// Matches the EMAIL_OUTBOX_FILE path computed in playwright.config.ts.
const OUTBOX_FILE = path.resolve(__dirname, '.outbox/emails.jsonl')

interface OutboxLine {
  to: string
  subject: string
  html: string
  sentAt: string
}

async function readOutboxLines(): Promise<OutboxLine[]> {
  let content: string
  try {
    content = await readFile(OUTBOX_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as OutboxLine)
}

test.beforeAll(async () => {
  // Stale lines from a previous run must never match the current test's email.
  await rm(OUTBOX_FILE, { force: true })
})

test('register, log out, forgot password with a real reset round trip, then log in', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.com`
  const oldPassword = 'correct-horse-battery-staple'
  const newPassword = 'correct-horse-battery-staple-2'

  await page.goto('/register')
  await page.getByPlaceholder('Name').fill('E2E Test User')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(oldPassword)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/forgot-password')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(
    page.getByText('If an account exists for that email, a reset link has been sent.'),
  ).toBeVisible()

  // Poll the file outbox for the reset email (the dev server writes it
  // asynchronously) and pull the reset URL out of its HTML body.
  let resetUrl: string | null = null
  await expect
    .poll(
      async () => {
        const lines = await readOutboxLines()
        const match = [...lines].reverse().find((line) => line.to === email)
        resetUrl = match ? (match.html.match(/href="([^"]+)"/)?.[1] ?? null) : null
        return resetUrl
      },
      { timeout: 10_000, message: 'waiting for password reset email in the file outbox' },
    )
    .not.toBeNull()

  // Better Auth's reset link points at its own verification endpoint, which
  // redirects to /reset-password?token=... on success.
  await page.goto(resetUrl!)
  await expect(page).toHaveURL(/\/reset-password\?token=/)
  await page.getByPlaceholder('New password').fill(newPassword)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect(page).toHaveURL(/\/login/)

  // The old password must no longer work.
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(oldPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Invalid email or password')).toBeVisible()

  // The new password does.
  await page.getByPlaceholder('Password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard/)
})

test('a logged-out visitor is redirected to /login from protected routes', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/settings')
  await expect(page).toHaveURL(/\/login/)
})

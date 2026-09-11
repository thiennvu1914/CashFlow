import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * `getEmailSender()` now runs the server environment contract
 * (`lib/server/env.ts`) first, which is fatal in production. The two
 * production cases below are about the transport refusal, not about the env
 * contract, so they stub an otherwise fully configured production environment:
 * the only thing missing is SMTP, and the error must still be the transport's
 * own.
 */
function stubValidProductionEnvExceptSmtp(): void {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@db.internal:5432/cashflow')
  vi.stubEnv('BETTER_AUTH_SECRET', 'w3Ky8Q1nZs6tVb2LpX0fJr7HgD4aMcEu')
  vi.stubEnv('BETTER_AUTH_URL', 'https://app.example.com')
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '10.0.0.0/8')
  vi.stubEnv('EMAIL_FROM', 'CashFlow <no-reply@example.com>')
  vi.stubEnv('SMTP_HOST', '')
}

describe('getEmailSender', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the console sender when SMTP is not configured', async () => {
    // Every input to the selection is stubbed, including the two that would
    // otherwise be picked up from the developer's own `.env` (loaded by the
    // `dotenv/config` setup file in `vitest.config.ts`) and flip this case to
    // the file sender or the production throw.
    vi.stubEnv('SMTP_HOST', '')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '')
    vi.stubEnv('NODE_ENV', 'development')
    const { getEmailSender } = await import('./get-sender')
    const { ConsoleEmailSender } = await import('./console-sender')
    expect(getEmailSender()).toBeInstanceOf(ConsoleEmailSender)
  })

  it('returns the SMTP sender when SMTP is configured', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_PORT', '587')
    vi.stubEnv('SMTP_USER', 'user')
    vi.stubEnv('SMTP_PASSWORD', 'pass')
    const { getEmailSender } = await import('./get-sender')
    const { SmtpEmailSender } = await import('./smtp-sender')
    expect(getEmailSender()).toBeInstanceOf(SmtpEmailSender)
  })

  it('returns the file sender when SMTP is empty and EMAIL_OUTBOX_FILE is set outside production', async () => {
    vi.stubEnv('SMTP_HOST', '')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    vi.stubEnv('NODE_ENV', 'development')
    const { getEmailSender } = await import('./get-sender')
    const { FileEmailSender } = await import('./file-sender')
    expect(getEmailSender()).toBeInstanceOf(FileEmailSender)
  })

  it('throws in production even when EMAIL_OUTBOX_FILE is set — the file outbox is never a production transport', async () => {
    // A reset link is a bearer token. If a stray EMAIL_OUTBOX_FILE could win in
    // production, those tokens would land on disk and never reach the user.
    stubValidProductionEnvExceptSmtp()
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  })

  it('throws a configuration error in production when nothing is configured', async () => {
    stubValidProductionEnvExceptSmtp()
    vi.stubEnv('EMAIL_OUTBOX_FILE', '')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  })

  it('throws when SMTP_HOST is set but SMTP_PORT is missing or invalid', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_PORT', '')
    vi.stubEnv('SMTP_USER', 'user')
    vi.stubEnv('SMTP_PASSWORD', 'super-secret-password')
    const { getEmailSender } = await import('./get-sender')

    let error: unknown
    try {
      getEmailSender()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'SMTP_PORT must be a positive integer when SMTP_HOST is set',
    )
    expect((error as Error).message).not.toContain('super-secret-password')
  })
})

describe('ConsoleEmailSender', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('writes exactly the expected block via console.log and nothing else', async () => {
    const { ConsoleEmailSender } = await import('./console-sender')
    const sender = new ConsoleEmailSender()

    await sender.send({ to: 'a@example.com', subject: 'Hello', html: '<p>Hi</p>' })

    expect(logSpy).toHaveBeenCalledTimes(5)
    expect(logSpy.mock.calls).toEqual([
      ['--- DEV EMAIL ---'],
      ['To: a@example.com'],
      ['Subject: Hello'],
      ['<p>Hi</p>'],
      ['-----------------'],
    ])

    const loggedText = logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
    expect(loggedText).toBe(
      [
        '--- DEV EMAIL ---',
        'To: a@example.com',
        'Subject: Hello',
        '<p>Hi</p>',
        '-----------------',
      ].join('\n'),
    )
  })
})

describe('FileEmailSender', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cashflow-email-outbox-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it('appends a parseable JSON line with to, subject, and html', async () => {
    const { FileEmailSender } = await import('./file-sender')
    const outboxFile = join(dir, 'nested', 'outbox.jsonl')
    vi.stubEnv('EMAIL_OUTBOX_FILE', outboxFile)

    const sender = new FileEmailSender()
    await sender.send({ to: 'b@example.com', subject: 'Reset', html: '<p>Link</p>' })

    const contents = await readFile(outboxFile, 'utf-8')
    const lines = contents.trim().split('\n')
    expect(lines).toHaveLength(1)

    const parsed = JSON.parse(lines[0])
    expect(parsed.to).toBe('b@example.com')
    expect(parsed.subject).toBe('Reset')
    expect(parsed.html).toBe('<p>Link</p>')
    expect(typeof parsed.sentAt).toBe('string')
  })
})

describe('sendResetPasswordEmail', () => {
  it('sends to the given address with the expected subject and a link containing the reset URL', async () => {
    const { sendResetPasswordEmail } = await import('./send-reset-password-email')
    const fakeSender = { send: vi.fn().mockResolvedValue(undefined) }
    const resetUrl = 'https://app.example.com/reset-password?token=abc123'

    await sendResetPasswordEmail('c@example.com', resetUrl, fakeSender)

    expect(fakeSender.send).toHaveBeenCalledTimes(1)
    const message = fakeSender.send.mock.calls[0][0]
    expect(message.to).toBe('c@example.com')
    expect(message.subject).toBe('Reset your CashFlow password')
    expect(message.html).toContain(resetUrl)
  })
})

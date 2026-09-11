import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * `getEmailSender()` runs the server environment contract
 * (`lib/server/env.ts`) first, and that contract is fatal in a production
 * runtime. The production cases below stub an otherwise fully configured
 * production environment so each one exercises exactly the rule it names.
 */
function stubProductionEnv(): void {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PHASE', '')
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@db.internal:5432/cashflow')
  vi.stubEnv('BETTER_AUTH_SECRET', 'w3Ky8Q1nZs6tVb2LpX0fJr7HgD4aMcEu')
  vi.stubEnv('BETTER_AUTH_URL', 'https://app.example.com')
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '10.0.0.0/8')
  vi.stubEnv('EMAIL_FROM', 'CashFlow <no-reply@example.com>')
  vi.stubEnv('SMTP_HOST', '')
  vi.stubEnv('SMTP_PORT', '')
  vi.stubEnv('SMTP_USER', '')
  vi.stubEnv('SMTP_PASSWORD', '')
  vi.stubEnv('EMAIL_OUTBOX_FILE', '')
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

  it('refuses a production runtime without SMTP, naming the variable and no value', async () => {
    stubProductionEnv()
    const { getEmailSender } = await import('./get-sender')

    let error: unknown
    try {
      getEmailSender()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('SMTP_HOST')
    expect((error as Error).message).not.toContain('db.internal')
  })

  it('refuses a production runtime with a stray EMAIL_OUTBOX_FILE and no SMTP — the file outbox is never a production transport', async () => {
    // A reset link is a bearer token. If a stray EMAIL_OUTBOX_FILE could win in
    // production, those tokens would land on disk and never reach the user.
    stubProductionEnv()
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(/SMTP_HOST/)
  })

  it('keeps the transport refusal during `next build`, which the env contract exempts', async () => {
    // NODE_ENV=production with NEXT_PHASE set skips the env contract, so this
    // is the path on which getEmailSender()'s own production check is the only
    // thing standing between a build-time send and the file outbox.
    stubProductionEnv()
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  })

  it('returns the SMTP sender in production even when EMAIL_OUTBOX_FILE is set', async () => {
    stubProductionEnv()
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_PORT', '587')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    const { getEmailSender } = await import('./get-sender')
    const { SmtpEmailSender } = await import('./smtp-sender')
    expect(getEmailSender()).toBeInstanceOf(SmtpEmailSender)
  })

  it('refuses a production runtime whose SMTP_USER has no SMTP_PASSWORD', async () => {
    stubProductionEnv()
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_PORT', '587')
    vi.stubEnv('SMTP_USER', 'mailer')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(/SMTP_PASSWORD/)
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

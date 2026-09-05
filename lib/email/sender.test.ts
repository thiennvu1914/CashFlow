import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('getEmailSender', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the console sender when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '')
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

  it('returns the file sender when SMTP is empty and EMAIL_OUTBOX_FILE is set', async () => {
    vi.stubEnv('SMTP_HOST', '')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '/tmp/some-outbox.jsonl')
    const { getEmailSender } = await import('./get-sender')
    const { FileEmailSender } = await import('./file-sender')
    expect(getEmailSender()).toBeInstanceOf(FileEmailSender)
  })

  it('throws a configuration error in production when nothing is configured', async () => {
    vi.stubEnv('SMTP_HOST', '')
    vi.stubEnv('EMAIL_OUTBOX_FILE', '')
    vi.stubEnv('NODE_ENV', 'production')
    const { getEmailSender } = await import('./get-sender')
    expect(() => getEmailSender()).toThrowError(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  })
})

describe('ConsoleEmailSender', () => {
  it('writes to, subject, and html via console.log and nothing else', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ConsoleEmailSender } = await import('./console-sender')
    const sender = new ConsoleEmailSender()

    await sender.send({ to: 'a@example.com', subject: 'Hello', html: '<p>Hi</p>' })

    const loggedText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(loggedText).toContain('a@example.com')
    expect(loggedText).toContain('Hello')
    expect(loggedText).toContain('<p>Hi</p>')

    logSpy.mockRestore()
  })
})

describe('FileEmailSender', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cashflow-email-outbox-'))
  })

  afterEach(async () => {
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

    vi.unstubAllEnvs()
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

import { mkdir, appendFile } from 'fs/promises'
import { dirname } from 'path'
import type { EmailSender, EmailMessage } from './sender'

/**
 * Appends one JSON line per message to the file named by
 * `process.env.EMAIL_OUTBOX_FILE`. Used so Playwright E2E tests can read the
 * password-reset URL without a real SMTP server.
 */
export class FileEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    const outboxFile = process.env.EMAIL_OUTBOX_FILE
    if (!outboxFile) {
      throw new Error('EMAIL_OUTBOX_FILE is not set')
    }

    await mkdir(dirname(outboxFile), { recursive: true })

    const line = JSON.stringify({
      to: message.to,
      subject: message.subject,
      html: message.html,
      sentAt: new Date().toISOString(),
    })
    await appendFile(outboxFile, `${line}\n`)
  }
}

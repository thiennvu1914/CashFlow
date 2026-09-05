import type { EmailSender } from './sender'
import { ConsoleEmailSender } from './console-sender'
import { SmtpEmailSender } from './smtp-sender'
import { FileEmailSender } from './file-sender'

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function getEmailSender(): EmailSender {
  if (isSet(process.env.SMTP_HOST)) {
    const port = Number.parseInt(process.env.SMTP_PORT ?? '', 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('SMTP_PORT must be a positive integer when SMTP_HOST is set')
    }
    return new SmtpEmailSender()
  }
  if (isSet(process.env.EMAIL_OUTBOX_FILE)) {
    return new FileEmailSender()
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  }
  return new ConsoleEmailSender()
}

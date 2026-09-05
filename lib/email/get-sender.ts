import type { EmailSender } from './sender'
import { ConsoleEmailSender } from './console-sender'
import { SmtpEmailSender } from './smtp-sender'
import { FileEmailSender } from './file-sender'

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function getEmailSender(): EmailSender {
  if (isSet(process.env.SMTP_HOST)) {
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

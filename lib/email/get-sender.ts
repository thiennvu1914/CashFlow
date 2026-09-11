import type { EmailSender } from './sender'
import { ConsoleEmailSender } from './console-sender'
import { SmtpEmailSender } from './smtp-sender'
import { FileEmailSender } from './file-sender'
import { loadServerEnv } from '@/lib/server/env'

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Picks the email transport for this process.
 *
 * Order matters and is a security property, not a preference: real SMTP wins
 * whenever it is configured, and production has exactly one legal answer —
 * SMTP or a hard failure. The production check therefore sits ABOVE the file
 * outbox, so a stray `EMAIL_OUTBOX_FILE` in a production environment can never
 * silently divert password-reset links (which are bearer tokens) to a file on
 * disk instead of to the user. The file and console senders are dev/E2E-only.
 */
export function getEmailSender(): EmailSender {
  // Runs the one server environment contract (cached per process). In a
  // production runtime it has already refused to start without SMTP_HOST,
  // SMTP_PORT and EMAIL_FROM, so the two layers agree: SMTP is the only
  // transport production accepts, and the refusal happens before the first
  // send rather than in place of it.
  loadServerEnv()

  if (isSet(process.env.SMTP_HOST)) {
    const port = Number.parseInt(process.env.SMTP_PORT ?? '', 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('SMTP_PORT must be a positive integer when SMTP_HOST is set')
    }
    return new SmtpEmailSender()
  }
  // Kept as the last line of defence even though `lib/server/env.ts` now makes
  // the same demand at boot: the env contract exempts the `next build` page-
  // data pass (`NEXT_PHASE=phase-production-build`), which still runs with
  // NODE_ENV=production, and a stray EMAIL_OUTBOX_FILE must not win there
  // either. Same rule, same variable, stated by whichever layer is reached
  // first.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Email is not configured: set SMTP_HOST (and related SMTP_* variables) in production',
    )
  }
  if (isSet(process.env.EMAIL_OUTBOX_FILE)) {
    return new FileEmailSender()
  }
  return new ConsoleEmailSender()
}

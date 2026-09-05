import { getEmailSender } from './get-sender'
import type { EmailSender } from './sender'

export async function sendResetPasswordEmail(
  to: string,
  resetUrl: string,
  sender: EmailSender = getEmailSender(),
): Promise<void> {
  await sender.send({
    to,
    subject: 'Reset your CashFlow password',
    html: `<p>Click the link below to reset your CashFlow password. This link expires soon and can only be used once.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  })
}

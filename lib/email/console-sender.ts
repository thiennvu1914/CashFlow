import type { EmailSender, EmailMessage } from './sender'

export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log('--- DEV EMAIL ---')
    console.log(`To: ${message.to}`)
    console.log(`Subject: ${message.subject}`)
    console.log(message.html)
    console.log('-----------------')
  }
}

import { getEmailSender } from './get-sender'
import type { EmailSender } from './sender'

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export async function sendResetPasswordEmail(
  to: string,
  resetUrl: string,
  sender: EmailSender = getEmailSender(),
): Promise<void> {
  const safeResetUrl = escapeHtmlAttribute(resetUrl)

  await sender.send({
    to,
    subject: 'Reset your CashFlow password',
    html: `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>Reset your CashFlow password</title>
  </head>

  <body
    style="
      margin: 0;
      padding: 0;
      background-color: #f6f7f5;
      font-family: Arial, Helvetica, sans-serif;
      color: #19211e;
    "
  >
    <div
      style="
        display: none;
        max-height: 0;
        overflow: hidden;
        opacity: 0;
      "
    >
      Reset your CashFlow password securely.
    </div>

    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      border="0"
      style="background-color: #f6f7f5; padding: 40px 16px;"
    >
      <tr>
        <td align="center">
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            border="0"
            style="
              max-width: 560px;
              background-color: #ffffff;
              border: 1px solid #e4e8e5;
              border-radius: 16px;
              overflow: hidden;
            "
          >
            <tr>
              <td
                style="
                  height: 4px;
                  background-color: #216b5b;
                  font-size: 0;
                  line-height: 0;
                "
              >
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style="padding: 36px 40px 12px 40px;">
                <img
                  src="https://cashflow.astravn.online/brand/cashflow-logo.png"
                  width="180"
                  alt="CashFlow"
                  style="
                    display: block;
                    width: 180px;
                    max-width: 100%;
                    height: auto;
                    border: 0;
                  "
                />
              </td>
            </tr>

            <tr>
              <td style="padding: 20px 40px 8px 40px;">
                <h1
                  style="
                    margin: 0;
                    font-size: 26px;
                    line-height: 1.3;
                    font-weight: 700;
                    color: #19211e;
                  "
                >
                  Reset your password
                </h1>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 8px 40px 0 40px;
                  font-size: 15px;
                  line-height: 1.7;
                  color: #53605b;
                "
              >
                We received a request to reset the password for your CashFlow
                account.
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 10px 40px 0 40px;
                  font-size: 15px;
                  line-height: 1.7;
                  color: #53605b;
                "
              >
                Click the button below to choose a new password.
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 28px 40px;">
                <table
                  role="presentation"
                  cellspacing="0"
                  cellpadding="0"
                  border="0"
                >
                  <tr>
                    <td
                      align="center"
                      bgcolor="#216B5B"
                      style="border-radius: 10px;"
                    >
                      <a
                        href="${safeResetUrl}"
                        target="_blank"
                        style="
                          display: inline-block;
                          padding: 14px 28px;
                          font-size: 15px;
                          font-weight: 700;
                          line-height: 1;
                          color: #ffffff;
                          text-decoration: none;
                          border-radius: 10px;
                        "
                      >
                        Reset password
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 0 40px;
                  font-size: 13px;
                  line-height: 1.6;
                  color: #6d7773;
                "
              >
                This link expires soon and can only be used once. For your
                security, do not forward this email or share this link with
                anyone.
              </td>
            </tr>

            <tr>
              <td style="padding: 24px 40px 0 40px;">
                <div
                  style="
                    border-top: 1px solid #e8ece9;
                    padding-top: 24px;
                  "
                >
                  <p
                    style="
                      margin: 0 0 8px 0;
                      font-size: 13px;
                      line-height: 1.6;
                      color: #6d7773;
                    "
                  >
                    If the button does not work, copy and paste this link into
                    your browser:
                  </p>

                  <p
                    style="
                      margin: 0;
                      font-size: 12px;
                      line-height: 1.6;
                      word-break: break-all;
                    "
                  >
                    <a
                      href="${safeResetUrl}"
                      target="_blank"
                      style="color: #216b5b; text-decoration: underline;"
                    >
                      ${safeResetUrl}
                    </a>
                  </p>
                </div>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 28px 40px 36px 40px;
                  font-size: 13px;
                  line-height: 1.6;
                  color: #6d7773;
                "
              >
                If you did not request a password reset, you can safely ignore
                this email. Your password will remain unchanged.
              </td>
            </tr>
          </table>

          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            border="0"
            style="max-width: 560px;"
          >
            <tr>
              <td
                align="center"
                style="
                  padding: 24px 20px;
                  font-size: 12px;
                  line-height: 1.6;
                  color: #84908b;
                "
              >
                CashFlow · Personal finance management
                <br />
                <a
                  href="https://cashflow.astravn.online"
                  style="
                    color: #5576a3;
                    text-decoration: none;
                  "
                >
                  cashflow.astravn.online
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `.trim(),
  })
}

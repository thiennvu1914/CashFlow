import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import { loadMessages } from '@/lib/i18n/messages'
import viDebts from '@/messages/vi/debts.json'
import { UnlinkPaymentsChoice, unlinkConfirmDescription } from './unlink-from-account-dialog'

/**
 * "Bỏ ghi vào tài khoản / Remove from account" (final review F1): the confirm
 * dialog says what will be deleted — the opening (debt) or disbursement (loan)
 * transaction, and the payments' transactions when the box is ticked — and that
 * the balances move back. The dialog itself renders in a portal, which static
 * markup does not reach, so its two pieces are tested directly: the payments
 * choice it holds, and the description it shows for that choice.
 */
const vi = await loadMessages('vi')
const en = await loadMessages('en')

function renderChoice(
  props: Partial<Parameters<typeof UnlinkPaymentsChoice>[0]> = {},
  locale: 'vi' | 'en' = 'vi',
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Ho_Chi_Minh"
      messages={locale === 'vi' ? vi : en}
    >
      <UnlinkPaymentsChoice
        namespace="debts"
        count={2}
        checked
        onCheckedChange={() => {}}
        {...props}
      />
    </NextIntlClientProvider>,
  )
}

describe('UnlinkPaymentsChoice', () => {
  it('is a checkbox labelled with the number of payments recorded in an account, ticked by default', () => {
    const html = renderChoice()
    expect(html).toContain('Bỏ ghi cả 2 lần trả đã ghi vào tài khoản')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
  })

  it('reflects an unticked choice', () => {
    expect(renderChoice({ checked: false })).not.toMatch(/checked=""/)
  })

  it('counts loan instalments in English with the plural', () => {
    expect(renderChoice({ namespace: 'loans', count: 1 }, 'en')).toContain(
      'Also remove the 1 payment recorded in an account',
    )
  })

  it('keeps the whole label a touch target of at least 44 px below the icon rail', () => {
    expect(renderChoice()).toMatch(/<label[^>]*class="[^"]*min-h-11/)
  })
})

describe('unlinkConfirmDescription', () => {
  const translator = createTranslator({ locale: 'vi', messages: vi })
  // The merged tree is untyped here, so its keys are plain strings.
  const t = (key: string, values?: Record<string, string | number>) =>
    translator(key as never, values as never)

  it('says the opening transaction goes and the recorded payments keep theirs when the box is unticked', () => {
    const text = unlinkConfirmDescription(t, 'debts', 2, false)
    expect(text).toBe(viDebts.unlinkConfirmBody)
    expect(text).toContain('số dư tài khoản trở lại')
  })

  it('says the payment transactions go too, and how many, when the box is ticked', () => {
    const text = unlinkConfirmDescription(t, 'loans', 3, true)
    expect(text).toContain('3 lần trả')
    expect(text).toContain('số dư tài khoản trở lại')
  })

  it('has nothing to say about payments when none is recorded in an account', () => {
    expect(unlinkConfirmDescription(t, 'debts', 0, true)).toBe(viDebts.unlinkConfirmBody)
  })
})

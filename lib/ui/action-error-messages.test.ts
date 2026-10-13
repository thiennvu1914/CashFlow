import { describe, expect, it } from 'vitest'
import viErrors from '@/messages/vi/errors.json'
import enErrors from '@/messages/en/errors.json'
import {
  DEBT_ERROR_KEYS,
  DEBT_FROZEN_ACCOUNT_ERROR_KEYS,
  LOAN_ERROR_KEYS,
  LOAN_FROZEN_ACCOUNT_ERROR_KEYS,
} from './action-error-messages'

describe('archived-account copy for paths that change existing transactions', () => {
  // Remove from account and payment delete have nothing to "choose another" of,
  // so they must not reuse the create/link copy that says to choose one.
  it.each([
    [
      'debt',
      DEBT_ERROR_KEYS,
      DEBT_FROZEN_ACCOUNT_ERROR_KEYS,
      'errors.debt.ARCHIVED_ACCOUNT_FROZEN',
    ],
    [
      'loan',
      LOAN_ERROR_KEYS,
      LOAN_FROZEN_ACCOUNT_ERROR_KEYS,
      'errors.loan.ARCHIVED_ACCOUNT_FROZEN',
    ],
  ] as const)(
    '%s: its own key, in both languages, and every other code unchanged',
    (ns, base, frozen, key) => {
      expect(frozen.ARCHIVED_ACCOUNT).toBe(key)
      expect({ ...frozen, ARCHIVED_ACCOUNT: base.ARCHIVED_ACCOUNT }).toEqual(base)
      for (const errors of [viErrors, enErrors]) {
        const block = errors[ns]
        expect(block.ARCHIVED_ACCOUNT_FROZEN).toBeTruthy()
        expect(block.ARCHIVED_ACCOUNT_FROZEN).not.toBe(block.ARCHIVED_ACCOUNT)
      }
      expect(viErrors[ns].ARCHIVED_ACCOUNT_FROZEN).not.toMatch(/chọn/)
      expect(enErrors[ns].ARCHIVED_ACCOUNT_FROZEN).not.toMatch(/choose/i)
    },
  )
})

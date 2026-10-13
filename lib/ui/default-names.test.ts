import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_TYPES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
} from '@/lib/server/defaults'
import enMessages from '@/messages/en/categories.json'
import viMessages from '@/messages/vi/categories.json'
import { displayAccountTypeName, displayCategoryName } from './default-names'

function translator(labels: typeof viMessages) {
  return (key: string) => {
    const value = key
      .split('.')
      .slice(1)
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], labels)
    if (typeof value !== 'string') throw new Error(`missing ${key}`)
    return value
  }
}

const tVi = translator(viMessages)
const tEn = translator(enMessages as typeof viMessages)
const categories = [...new Set([...DEFAULT_EXPENSE_CATEGORIES, ...DEFAULT_INCOME_CATEGORIES])]

describe('default names', () => {
  it('has a vi and en label for every default, English matching the stored name', () => {
    for (const name of categories) {
      expect(displayCategoryName({ name, isDefault: true }, tEn)).toBe(name)
      expect(displayCategoryName({ name, isDefault: true }, tVi)).not.toBe('')
    }
    for (const name of DEFAULT_ACCOUNT_TYPES) {
      expect(displayAccountTypeName({ name, isDefault: true }, tEn)).toBe(name)
      expect(displayAccountTypeName({ name, isDefault: true }, tVi)).not.toBe('')
    }
  })

  it('translates defaults into Vietnamese', () => {
    expect(displayCategoryName({ name: 'Food & Dining', isDefault: true }, tVi)).toBe('Ăn uống')
    expect(displayCategoryName({ name: 'Loan Interest & Fees', isDefault: true }, tVi)).toBe(
      'Lãi vay & phí',
    )
    expect(displayAccountTypeName({ name: 'Bank Account', isDefault: true }, tVi)).toBe(
      'Tài khoản ngân hàng',
    )
  })

  it('passes user-created and renamed names through as stored', () => {
    expect(displayCategoryName({ name: 'Food & Dining', isDefault: false }, tVi)).toBe(
      'Food & Dining',
    )
    expect(displayCategoryName({ name: 'Rent', isDefault: true }, tVi)).toBe('Rent')
    expect(displayCategoryName({ name: 'constructor', isDefault: true }, tVi)).toBe('constructor')
    expect(displayAccountTypeName({ name: 'Cash', isDefault: false }, tVi)).toBe('Cash')
  })
})

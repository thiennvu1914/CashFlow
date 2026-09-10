import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import type { DebtRow, DebtWithOutstanding } from '@/lib/server/services/debt'
import { debtSubtotalsByCurrency, toDebtDto } from './debt-view-model'

/**
 * Pure mapping — no database, no session, no renderer. These cases pin the one
 * `toNumber()` this DTO performs (`percentPaid`, the bar's width), the one place
 * a percentage is rounded (`percentLabel`, half-up on the `Decimal` rather than
 * on the float), that every figure is formatted in the debt's OWN currency, and
 * — the case this module exists for — that a subtotal never sums two
 * currencies together.
 *
 * `displayStatus` is *not* recomputed here: the service derives it (under the
 * user's `today`) and this file only labels it, so there is no second, drifting
 * definition of "overdue" in the UI.
 */

const CREATED_AT = new Date('2026-03-01T04:05:06.000Z')

function payment(
  overrides: Partial<DebtRow['payments'][number]> = {},
): DebtRow['payments'][number] {
  return {
    id: 'pay_1',
    userId: 'user_1',
    debtId: 'debt_1',
    amount: new Prisma.Decimal('250000'),
    date: new Date('2026-03-02T00:00:00.000Z'),
    note: null,
    createdAt: CREATED_AT,
    ...overrides,
  }
}

function debt(overrides: Partial<DebtRow> = {}): DebtRow {
  return {
    id: 'debt_1',
    userId: 'user_1',
    direction: 'RECEIVABLE',
    person: 'Minh',
    description: null,
    originalAmount: new Prisma.Decimal('1000000'),
    currency: 'VND',
    dueDate: null,
    status: 'ACTIVE',
    notes: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    payments: [],
    ...overrides,
  }
}

/** A service row, with `paid`/`outstanding` derived exactly as
 *  `getDebtsWithOutstanding` derives them, so no case can assert an
 *  arithmetically impossible combination. */
function row(
  overrides: Partial<DebtRow> = {},
  displayStatus: DebtWithOutstanding['displayStatus'] = 'OPEN',
): DebtWithOutstanding {
  const debtRow = debt(overrides)
  const paid = debtRow.payments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0))
  return {
    debt: debtRow,
    paid,
    outstanding: debtRow.originalAmount.sub(paid),
    displayStatus,
  }
}

/**
 * True only for an object literal — the kind of value this walk should descend
 * *into*. A `Date` and a `Prisma.Decimal` are objects too, but their prototypes
 * are their own, so they come back false and are treated as leaves: they are
 * precisely what the case has to inspect rather than recurse through.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Every leaf inside a DTO as `[path, value]` pairs, recursing through arrays and
 * object literals so a value nested in `editable` or in `payments[n]` is
 * reached rather than skipped.
 *
 * The path is carried along purely so a failure names the field that leaked
 * ("dto.payments[0].amount is a Prisma.Decimal") instead of leaving the reader
 * to find it.
 */
function leafValues(value: unknown, path = 'dto'): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafValues(item, `${path}[${index}]`))
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => leafValues(item, `${path}.${key}`))
  }
  return [[path, value]]
}

describe('toDebtDto', () => {
  it('maps an untouched VND receivable: own currency, whole dong, 0 % paid', () => {
    const dto = toDebtDto(row())

    expect(dto.id).toBe('debt_1')
    expect(dto.person).toBe('Minh')
    expect(dto.direction).toBe('RECEIVABLE')
    expect(dto.currency).toBe('VND')
    expect(dto.original).toBe('1.000.000')
    expect(dto.paid).toBe('0')
    expect(dto.outstanding).toBe('1.000.000')
    expect(dto.percentPaid).toBe(0)
    expect(dto.percentLabel).toBe('0 %')
    expect(dto.status).toBe('OPEN')
    expect(dto.active).toBe(true)
    expect(dto.dueDate).toBeNull()
    expect(dto.description).toBeNull()
    expect(dto.notes).toBeNull()
    expect(dto.payments).toEqual([])
  })

  it('keeps the direction as the raw enum, for the component to label', () => {
    const dto = toDebtDto(row({ direction: 'PAYABLE' }))

    expect(dto.direction).toBe('PAYABLE')
  })

  it('formats a USD debt with its two decimals, never converted to VND', () => {
    const dto = toDebtDto(
      row(
        {
          currency: 'USD',
          originalAmount: new Prisma.Decimal('2000'),
          payments: [payment({ amount: new Prisma.Decimal('1500.50') })],
        },
        'PARTIALLY_PAID',
      ),
    )

    // Vietnamese grouping (the reader's locale) with USD precision (the money's).
    expect(dto.original).toBe('2.000,00')
    expect(dto.paid).toBe('1.500,50')
    expect(dto.outstanding).toBe('499,50')
    expect(dto.currency).toBe('USD')
    expect(dto.status).toBe('PARTIALLY_PAID')
  })

  it('reports a part-paid debt as its share of the original', () => {
    const dto = toDebtDto(
      row({ payments: [payment({ amount: new Prisma.Decimal('250000') })] }, 'PARTIALLY_PAID'),
    )

    expect(dto.paid).toBe('250.000')
    expect(dto.outstanding).toBe('750.000')
    expect(dto.percentPaid).toBe(25)
    expect(dto.percentLabel).toBe('25 %')
  })

  it('rounds the label half-up on the Decimal, not on a float', () => {
    // 2 paid of 3: 66.666…%, which must read 67 % and never 66 %.
    const dto = toDebtDto(
      row(
        {
          originalAmount: new Prisma.Decimal('3'),
          payments: [payment({ amount: new Prisma.Decimal('2') })],
        },
        'PARTIALLY_PAID',
      ),
    )

    expect(dto.percentLabel).toBe('67 %')
    // The bar keeps the unrounded width, so label and bar agree on the reading
    // without the bar inheriting the label's rounding.
    expect(dto.percentPaid).toBeCloseTo(66.6667, 3)
  })

  it('fills the bar at exactly settled, and clamps it if the data ever went past', () => {
    const settled = toDebtDto(
      row({ payments: [payment({ amount: new Prisma.Decimal('1000000') })] }, 'PAID'),
    )
    expect(settled.percentPaid).toBe(100)
    expect(settled.percentLabel).toBe('100 %')
    expect(settled.outstanding).toBe('0')
    expect(settled.status).toBe('PAID')

    // The service refuses an overpayment under a row lock, so this is only
    // reachable by writing rows around it — the bar must still not overflow
    // its track, while the label keeps telling the truth.
    const overpaid = toDebtDto(
      row({ payments: [payment({ amount: new Prisma.Decimal('1200000') })] }, 'PAID'),
    )
    expect(overpaid.percentPaid).toBe(100)
    expect(overpaid.percentLabel).toBe('120 %')
  })

  it('reads the due date in UTC, so a carrier is the day the user picked', () => {
    // A carrier is UTC midnight. Read in any zone west of UTC it would come
    // back as the previous day — which is exactly the bug this asserts against.
    const dto = toDebtDto(row({ dueDate: new Date('2026-04-01T00:00:00.000Z') }, 'OVERDUE'))

    expect(dto.dueDate).toBe('2026-04-01')
    expect(dto.status).toBe('OVERDUE')
  })

  it('marks a written-off debt inactive, keeping the raw status enum', () => {
    const dto = toDebtDto(row({ status: 'WRITTEN_OFF' }, 'WRITTEN_OFF'))

    expect(dto.status).toBe('WRITTEN_OFF')
    // What the page keys the row actions off: a written-off debt refuses every
    // write, so no button may be offered for it.
    expect(dto.active).toBe(false)
  })

  it('carries no English direction/status literal, an enum key, and nothing else', () => {
    const dto = toDebtDto(row({ direction: 'PAYABLE' }, 'OVERDUE'))

    // No `directionLabel`/`statusLabel` (or any other translated string) on the
    // DTO at all — the component calls `debtDirectionLabelKey`/
    // `debtStatusLabelKey`.
    expect(Object.keys(dto)).not.toContain('directionLabel')
    expect(Object.keys(dto)).not.toContain('statusLabel')

    // `\b` word boundaries so a field NAME (`percentPaid`) cannot false-positive
    // this check — only a translated ENGLISH LABEL as a JSON *value* can.
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toMatch(
      /\bOpen\b|\bPartly paid\b|\bPaid\b|\bOverdue\b|\bWritten off\b|\bReceivable\b|\bPayable\b/,
    )
  })

  it('maps the payment history to strings, oldest first, keeping the service order', () => {
    const dto = toDebtDto(
      row(
        {
          payments: [
            payment({
              id: 'pay_1',
              amount: new Prisma.Decimal('100000'),
              date: new Date('2026-03-02T00:00:00.000Z'),
              note: 'First instalment',
            }),
            payment({
              id: 'pay_2',
              amount: new Prisma.Decimal('150000.25'),
              date: new Date('2026-03-09T00:00:00.000Z'),
            }),
          ],
        },
        'PARTIALLY_PAID',
      ),
    )

    expect(dto.payments).toEqual([
      { id: 'pay_1', date: '2026-03-02', amount: '100.000', note: 'First instalment' },
      // Two decimals show on a VND amount that genuinely carries them rather
      // than being rounded away.
      { id: 'pay_2', date: '2026-03-09', amount: '150.000,25', note: null },
    ])
  })

  it('carries the edit form its own prefill, with no Decimal or Date crossing to the client', () => {
    const dto = toDebtDto(
      row({
        person: 'Minh Nguyen',
        description: 'Lunch money',
        dueDate: new Date('2026-06-30T00:00:00.000Z'),
        notes: 'Pay back after payday',
      }),
    )

    // The three fields that define a debt — direction, original amount and
    // currency — are deliberately absent: `updateDebtSchema` does not contain
    // them, so the edit form has nothing to prefill them with.
    expect(dto.editable).toEqual({
      person: 'Minh Nguyen',
      description: 'Lunch money',
      dueDate: '2026-06-30',
      notes: 'Pay back after payday',
    })
    for (const value of Object.values(dto.editable)) {
      expect(typeof value).toBe('string')
    }
  })

  it('empties the edit form fields the debt has no value for', () => {
    const dto = toDebtDto(row({ description: null, dueDate: null, notes: null }))

    // `''`, not `null`: these feed an `<input>`'s default value, and the schema
    // reads an empty due date as "no due date".
    expect(dto.editable).toEqual({ person: 'Minh', description: '', dueDate: '', notes: '' })
  })

  it('lets nothing but strings, numbers, booleans and nulls cross to a client component', () => {
    const dto = toDebtDto(
      row(
        {
          dueDate: new Date('2026-06-30T00:00:00.000Z'),
          payments: [payment()],
        },
        'PARTIALLY_PAID',
      ),
    )

    // `DebtRowActions` is a client component taking a whole `DebtDto`, and
    // neither a `Prisma.Decimal` nor a `Date` can survive that boundary.
    const leaves = leafValues(dto)
    const paths = leaves.map(([path]) => path)

    // First: the walk really reached the nested places a leak would hide in —
    // otherwise the loop below could pass over an empty list and assert
    // nothing at all.
    expect(paths).toContain('dto.dueDate')
    expect(paths).toContain('dto.outstanding')
    expect(paths).toContain('dto.editable.dueDate')
    expect(paths).toContain('dto.payments[0].date')
    expect(paths).toContain('dto.payments[0].amount')

    for (const [path, value] of leaves) {
      // Asserted by *identity*, never by `typeof`: `typeof new Date()` and
      // `typeof new Prisma.Decimal(0)` are both `'object'`, so a `typeof`
      // check is exactly the one that cannot see either leak.
      expect(value instanceof Date, `${path} is a Date`).toBe(false)
      expect(Prisma.Decimal.isDecimal(value), `${path} is a Prisma.Decimal`).toBe(false)
      // And the positive statement, so a leak of some *other* non-serialisable
      // object (a `Map`, a class instance a later field introduces) is caught
      // too: a primitive or `null` is the only thing a leaf may be.
      if (value !== null) {
        expect(['string', 'number', 'boolean'], `${path} is a ${typeof value}`).toContain(
          typeof value,
        )
      }
    }

    expect(dto.dueDate).toBe('2026-06-30')
  })
})

describe('debtSubtotalsByCurrency', () => {
  it('keeps a USD receivable and a VND payable as two separate rows', () => {
    const subtotals = debtSubtotalsByCurrency([
      row({ id: 'debt_usd', currency: 'USD', originalAmount: new Prisma.Decimal('500') }),
      row({ id: 'debt_vnd', direction: 'PAYABLE' }),
    ])

    // The whole reason this function exists: 500 USD and 1.000.000 VND is not
    // 1.000.500 of anything, and no FX rate is applied on this page.
    expect(subtotals).toEqual([
      { currency: 'VND', receivable: '0', payable: '1.000.000' },
      { currency: 'USD', receivable: '500,00', payable: '0,00' },
    ])
  })

  it('sums each direction within one currency, on the Decimal', () => {
    const subtotals = debtSubtotalsByCurrency([
      row({ id: 'a', originalAmount: new Prisma.Decimal('1000000.50') }),
      row({ id: 'b', originalAmount: new Prisma.Decimal('2000000.25') }),
      row({ id: 'c', direction: 'PAYABLE', originalAmount: new Prisma.Decimal('300000') }),
      row({
        id: 'd',
        direction: 'PAYABLE',
        originalAmount: new Prisma.Decimal('500000'),
        payments: [payment({ amount: new Prisma.Decimal('200000') })],
      }),
    ])

    expect(subtotals).toEqual([{ currency: 'VND', receivable: '3.000.000,75', payable: '600.000' }])
  })

  it('counts what is still outstanding, not what was originally agreed', () => {
    const subtotals = debtSubtotalsByCurrency([
      row({ payments: [payment({ amount: new Prisma.Decimal('400000') })] }, 'PARTIALLY_PAID'),
    ])

    expect(subtotals).toEqual([{ currency: 'VND', receivable: '600.000', payable: '0' }])
  })

  it('excludes a written-off debt, whatever is nominally still owed on it', () => {
    const subtotals = debtSubtotalsByCurrency([
      row({ id: 'live' }),
      row({ id: 'gone', status: 'WRITTEN_OFF' }, 'WRITTEN_OFF'),
    ])

    // A written-off debt is not an asset or a liability any more, so it must
    // not appear in a total the user reads as "what I am owed".
    expect(subtotals).toEqual([{ currency: 'VND', receivable: '1.000.000', payable: '0' }])
  })

  it('excludes a settled debt, so a fully repaid row adds nothing', () => {
    const subtotals = debtSubtotalsByCurrency([
      row({ id: 'live' }),
      row(
        { id: 'settled', payments: [payment({ amount: new Prisma.Decimal('1000000') })] },
        'PAID',
      ),
    ])

    expect(subtotals).toEqual([{ currency: 'VND', receivable: '1.000.000', payable: '0' }])
  })

  it('returns no rows at all when nothing is outstanding', () => {
    expect(debtSubtotalsByCurrency([])).toEqual([])
    expect(
      debtSubtotalsByCurrency([
        row({ status: 'WRITTEN_OFF' }, 'WRITTEN_OFF'),
        row(
          { id: 'settled', payments: [payment({ amount: new Prisma.Decimal('1000000') })] },
          'PAID',
        ),
      ]),
    ).toEqual([])
    // An empty list is what lets the page omit the strip rather than render a
    // row of zeroes.
  })

  it('orders the currencies the same way whatever order the debts arrive in', () => {
    const usd = row({ id: 'debt_usd', currency: 'USD', originalAmount: new Prisma.Decimal('500') })
    const vnd = row({ id: 'debt_vnd' })

    // A strip that reordered itself as debts were added or repaid would move
    // the figure the user was reading.
    expect(debtSubtotalsByCurrency([usd, vnd]).map((s) => s.currency)).toEqual(['VND', 'USD'])
    expect(debtSubtotalsByCurrency([vnd, usd]).map((s) => s.currency)).toEqual(['VND', 'USD'])
  })
})

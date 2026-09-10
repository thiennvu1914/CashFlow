import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import type { LoanRow, LoanWithOutstanding } from '@/lib/server/services/loan'
import { loanSubtotalsByCurrency, toLoanDto } from './loan-view-model'

/**
 * Pure mapping — no database, no session, no renderer. These cases pin the two
 * `toNumber()`s this DTO performs (`percentRepaid`, the bar's width, and the
 * interest rate, which is a percentage rather than money), the one place a
 * percentage is rounded (`percentLabel`, half-up on the `Decimal` rather than
 * on the float), that every figure is formatted in the loan's OWN currency, the
 * `dueSoon` window at each of its edges, and — the case this module exists for
 * — that a subtotal never sums two currencies together.
 *
 * `displayStatus` is *not* recomputed here: the service derives it (under the
 * user's `today`) and this file only labels it, so there is no second, drifting
 * definition of "overdue" in the UI. `dueSoon` is derived here because it is
 * not a service concept at all — it is a *presentation* window on a due date
 * the service already dated — and it is gated on the service's ACTIVE so the
 * two can never contradict each other.
 */

const CREATED_AT = new Date('2026-03-01T04:05:06.000Z')
/** The `today` every case below is read against, unless it says otherwise. */
const TODAY = '2026-04-15'

function payment(
  overrides: Partial<LoanRow['payments'][number]> = {},
): LoanRow['payments'][number] {
  return {
    id: 'pay_1',
    userId: 'user_1',
    loanId: 'loan_1',
    totalAmount: new Prisma.Decimal('5000000'),
    principalAmount: new Prisma.Decimal('3500000'),
    interestAmount: new Prisma.Decimal('1500000'),
    paymentDate: new Date('2026-03-15T00:00:00.000Z'),
    note: null,
    createdAt: CREATED_AT,
    ...overrides,
  }
}

function loan(overrides: Partial<LoanRow> = {}): LoanRow {
  return {
    id: 'loan_1',
    userId: 'user_1',
    lender: 'Vietcombank',
    principal: new Prisma.Decimal('240000000'),
    currency: 'VND',
    interestRate: new Prisma.Decimal('8.500'),
    startDate: new Date('2026-01-15T00:00:00.000Z'),
    termMonths: 60,
    paymentFrequency: 'MONTHLY',
    scheduledPaymentAmount: new Prisma.Decimal('5000000'),
    nextDueDate: new Date('2026-05-15T00:00:00.000Z'),
    dueDayOfMonth: 15,
    status: 'ACTIVE',
    notes: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    payments: [],
    ...overrides,
  }
}

/** A service row, with the three derived figures computed exactly as
 *  `getLoansWithOutstanding` computes them, so no case can assert an
 *  arithmetically impossible combination. */
function row(
  overrides: Partial<LoanRow> = {},
  displayStatus: LoanWithOutstanding['displayStatus'] = 'ACTIVE',
): LoanWithOutstanding {
  const loanRow = loan(overrides)
  const principalPaid = loanRow.payments.reduce(
    (sum, p) => sum.add(p.principalAmount),
    new Prisma.Decimal(0),
  )
  const interestPaid = loanRow.payments.reduce(
    (sum, p) => sum.add(p.interestAmount),
    new Prisma.Decimal(0),
  )
  return {
    loan: loanRow,
    principalPaid,
    interestPaid,
    outstandingPrincipal: loanRow.principal.sub(principalPaid),
    displayStatus,
  }
}

/** A UTC-midnight carrier for a `yyyy-MM-dd` day, so a case can name a due date
 *  relative to `TODAY` without hand-computing a month boundary. */
function carrier(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
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
 * ("dto.payments[0].total is a Prisma.Decimal") instead of leaving the reader
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

describe('toLoanDto', () => {
  it('maps an untouched VND loan: own currency, whole dong, 0 % repaid', () => {
    const dto = toLoanDto(row(), TODAY)

    expect(dto.id).toBe('loan_1')
    expect(dto.lender).toBe('Vietcombank')
    expect(dto.currency).toBe('VND')
    expect(dto.principal).toBe('240.000.000')
    expect(dto.principalPaid).toBe('0')
    expect(dto.interestPaid).toBe('0')
    expect(dto.outstandingPrincipal).toBe('240.000.000')
    expect(dto.percentRepaid).toBe(0)
    expect(dto.percentLabel).toBe('0 %')
    expect(dto.nextDueDate).toBe('2026-05-15')
    expect(dto.scheduledPayment).toBe('5.000.000')
    expect(dto.paymentFrequency).toBe('MONTHLY')
    expect(dto.interestRateLabel).toBe('8,5 %')
    expect(dto.termMonths).toBe(60)
    expect(dto.startDate).toBe('2026-01-15')
    expect(dto.status).toBe('ACTIVE')
    expect(dto.active).toBe(true)
    expect(dto.overdue).toBe(false)
    // 15 May is a month away from 15 April: outside the seven-day window.
    expect(dto.dueSoon).toBe(false)
    expect(dto.notes).toBeNull()
    expect(dto.payments).toEqual([])
  })

  it('formats a USD loan with its two decimals, never converted to VND', () => {
    const dto = toLoanDto(
      row({
        currency: 'USD',
        principal: new Prisma.Decimal('20000'),
        scheduledPaymentAmount: new Prisma.Decimal('450.75'),
        payments: [
          payment({
            totalAmount: new Prisma.Decimal('450.75'),
            principalAmount: new Prisma.Decimal('300.50'),
            interestAmount: new Prisma.Decimal('150.25'),
          }),
        ],
      }),
      TODAY,
    )

    // Vietnamese grouping (the reader's locale) with USD precision (the money's).
    expect(dto.currency).toBe('USD')
    expect(dto.principal).toBe('20.000,00')
    expect(dto.principalPaid).toBe('300,50')
    expect(dto.interestPaid).toBe('150,25')
    expect(dto.outstandingPrincipal).toBe('19.699,50')
    expect(dto.scheduledPayment).toBe('450,75')
  })

  it('reports interest paid separately, because it repays nothing', () => {
    const dto = toLoanDto(row({ payments: [payment()] }), TODAY)

    // 3.500.000 of principal came off the loan; the 1.500.000 of interest is
    // what the loan cost and reduces nothing — so it appears in neither the
    // outstanding figure nor the bar.
    expect(dto.principalPaid).toBe('3.500.000')
    expect(dto.interestPaid).toBe('1.500.000')
    expect(dto.outstandingPrincipal).toBe('236.500.000')
    expect(dto.percentRepaid).toBeCloseTo(1.4583, 3)
    expect(dto.percentLabel).toBe('1 %')
  })

  it('rounds the label half-up on the Decimal, not on a float', () => {
    // 2 repaid of 3: 66.666…%, which must read 67 % and never 66 %.
    const dto = toLoanDto(
      row({
        principal: new Prisma.Decimal('3'),
        payments: [
          payment({
            totalAmount: new Prisma.Decimal('2'),
            principalAmount: new Prisma.Decimal('2'),
            interestAmount: new Prisma.Decimal('0'),
          }),
        ],
      }),
      TODAY,
    )

    expect(dto.percentLabel).toBe('67 %')
    // The bar keeps the unrounded width, so label and bar agree on the reading
    // without the bar inheriting the label's rounding.
    expect(dto.percentRepaid).toBeCloseTo(66.6667, 3)
  })

  it('fills the bar at exactly repaid, and clamps it if the data ever went past', () => {
    const settled = toLoanDto(
      row(
        {
          payments: [
            payment({
              totalAmount: new Prisma.Decimal('240000000'),
              principalAmount: new Prisma.Decimal('240000000'),
              interestAmount: new Prisma.Decimal('0'),
            }),
          ],
        },
        'PAID_OFF',
      ),
      TODAY,
    )
    expect(settled.percentRepaid).toBe(100)
    expect(settled.percentLabel).toBe('100 %')
    expect(settled.outstandingPrincipal).toBe('0')
    expect(settled.status).toBe('PAID_OFF')

    // The service refuses an overpayment under a row lock, so this is only
    // reachable by writing rows around it — the bar must still not overflow
    // its track, while the label keeps telling the truth.
    const overpaid = toLoanDto(
      row(
        {
          payments: [
            payment({
              totalAmount: new Prisma.Decimal('288000000'),
              principalAmount: new Prisma.Decimal('288000000'),
              interestAmount: new Prisma.Decimal('0'),
            }),
          ],
        },
        'PAID_OFF',
      ),
      TODAY,
    )
    expect(overpaid.percentRepaid).toBe(100)
    expect(overpaid.percentLabel).toBe('120 %')
  })

  it('reads both carriers in UTC, so a stored date is the day the user picked', () => {
    // A carrier is UTC midnight. Read in any zone west of UTC it would come
    // back as the previous day — which is exactly the bug this asserts against.
    const dto = toLoanDto(
      row({
        startDate: carrier('2026-01-31'),
        nextDueDate: carrier('2026-05-31'),
      }),
      TODAY,
    )

    expect(dto.startDate).toBe('2026-01-31')
    expect(dto.nextDueDate).toBe('2026-05-31')
  })

  describe('dueSoon', () => {
    it('is true for an instalment due today', () => {
      const dto = toLoanDto(row({ nextDueDate: carrier(TODAY) }), TODAY)

      // Due today is not late (the service says ACTIVE, not OVERDUE) but it is
      // the most urgent thing on the page, so the window has to include it.
      expect(dto.status).toBe('ACTIVE')
      expect(dto.dueSoon).toBe(true)
      expect(dto.overdue).toBe(false)
    })

    it('is true on the seventh day, the last day inside the window', () => {
      const dto = toLoanDto(row({ nextDueDate: carrier('2026-04-22') }), TODAY)

      expect(dto.dueSoon).toBe(true)
    })

    it('is false on the eighth day, the first day outside it', () => {
      const dto = toLoanDto(row({ nextDueDate: carrier('2026-04-23') }), TODAY)

      expect(dto.dueSoon).toBe(false)
    })

    it('crosses a month boundary by the calendar, not by a 30-day step', () => {
      // 28 April + 7 days is 5 May. A `+7` on the day number would answer "35
      // April" and, compared as a string, put the due date outside the window.
      const dto = toLoanDto(row({ nextDueDate: carrier('2026-05-05') }), '2026-04-28')

      expect(dto.dueSoon).toBe(true)
      expect(toLoanDto(row({ nextDueDate: carrier('2026-05-06') }), '2026-04-28').dueSoon).toBe(
        false,
      )
    })

    it('is false for an overdue instalment, which is a different thing to say', () => {
      const dto = toLoanDto(row({ nextDueDate: carrier('2026-04-14') }, 'OVERDUE'), TODAY)

      // Yesterday. "Due soon" would understate it, and the row already reads
      // "Overdue" — the two flags are mutually exclusive by construction.
      expect(dto.overdue).toBe(true)
      expect(dto.dueSoon).toBe(false)
    })

    it('is false for a repaid loan whose stored due date is still inside the window', () => {
      // The last accepted payment advanced `nextDueDate` and nothing will ever
      // move it again, so a paid-off loan very often carries a due date a few
      // days out. Asking the user for another instalment would be wrong.
      const dto = toLoanDto(
        row(
          {
            nextDueDate: carrier('2026-04-16'),
            payments: [
              payment({
                totalAmount: new Prisma.Decimal('240000000'),
                principalAmount: new Prisma.Decimal('240000000'),
                interestAmount: new Prisma.Decimal('0'),
              }),
            ],
          },
          'PAID_OFF',
        ),
        TODAY,
      )

      expect(dto.dueSoon).toBe(false)
      expect(dto.overdue).toBe(false)
    })

    it('is false for a closed loan, whatever its due date says', () => {
      const dto = toLoanDto(
        row({ status: 'CLOSED', nextDueDate: carrier('2026-04-16') }, 'CLOSED'),
        TODAY,
      )

      expect(dto.dueSoon).toBe(false)
      expect(dto.overdue).toBe(false)
    })
  })

  it('marks a closed loan inactive, keeping the raw status enum', () => {
    const dto = toLoanDto(row({ status: 'CLOSED' }, 'CLOSED'), TODAY)

    expect(dto.status).toBe('CLOSED')
    // What the page keys the row actions off: a closed loan refuses every
    // write, so no button may be offered for it.
    expect(dto.active).toBe(false)
  })

  it('keeps an overdue loan active — a missed instalment is not a closed loan', () => {
    const dto = toLoanDto(row({ nextDueDate: carrier('2026-03-15') }, 'OVERDUE'), TODAY)

    expect(dto.status).toBe('OVERDUE')
    expect(dto.active).toBe(true)
  })

  it('carries no English frequency/status literal, an enum key, and nothing else', () => {
    const dto = toLoanDto(row({ paymentFrequency: 'WEEKLY' }, 'OVERDUE'), TODAY)

    // No `frequencyLabel`/`statusLabel` (or any other translated string) on the
    // DTO at all — the component calls `paymentFrequencyLabelKey`/
    // `loanStatusLabelKey`. `interestRateLabel` is the sanctioned exception
    // (see the module comment) and carries no such word either.
    expect(Object.keys(dto)).not.toContain('frequencyLabel')
    expect(Object.keys(dto)).not.toContain('statusLabel')

    // `\b` word boundaries so a field NAME (`principalPaid`) cannot
    // false-positive this check — only a translated ENGLISH LABEL as a JSON
    // *value* can.
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toMatch(
      /\bWeekly\b|\bMonthly\b|\bYearly\b|\bActive\b|\bOverdue\b|\bPaid off\b|\bClosed\b/,
    )
  })

  it('formats the interest rate as a Vietnamese percentage, up to three decimals', () => {
    // The stored column is `Decimal(6, 3)`, so a rate really can carry three.
    expect(
      toLoanDto(row({ interestRate: new Prisma.Decimal('8.500') }), TODAY).interestRateLabel,
    ).toBe('8,5 %')
    // 0 % is a real loan — the interest-free one from family.
    expect(
      toLoanDto(row({ interestRate: new Prisma.Decimal('0.000') }), TODAY).interestRateLabel,
    ).toBe('0 %')
    expect(
      toLoanDto(row({ interestRate: new Prisma.Decimal('12.345') }), TODAY).interestRateLabel,
    ).toBe('12,345 %')
    expect(
      toLoanDto(row({ interestRate: new Prisma.Decimal('100.000') }), TODAY).interestRateLabel,
    ).toBe('100 %')
  })

  it('keeps every payment frequency as the raw enum, for the component to label', () => {
    expect(toLoanDto(row({ paymentFrequency: 'WEEKLY' }), TODAY).paymentFrequency).toBe('WEEKLY')
    expect(toLoanDto(row({ paymentFrequency: 'MONTHLY' }), TODAY).paymentFrequency).toBe('MONTHLY')
    expect(toLoanDto(row({ paymentFrequency: 'YEARLY' }), TODAY).paymentFrequency).toBe('YEARLY')
  })

  it('maps the instalment history to strings, oldest first, keeping the service order', () => {
    const dto = toLoanDto(
      row({
        payments: [
          payment({
            id: 'pay_1',
            paymentDate: carrier('2026-02-15'),
            note: 'First instalment',
          }),
          payment({
            id: 'pay_2',
            totalAmount: new Prisma.Decimal('5000000.50'),
            principalAmount: new Prisma.Decimal('3600000.25'),
            interestAmount: new Prisma.Decimal('1400000.25'),
            paymentDate: carrier('2026-03-15'),
          }),
        ],
      }),
      TODAY,
    )

    expect(dto.payments).toEqual([
      {
        id: 'pay_1',
        date: '2026-02-15',
        total: '5.000.000',
        principal: '3.500.000',
        interest: '1.500.000',
        note: 'First instalment',
      },
      // Two decimals show on a VND amount that genuinely carries them rather
      // than being rounded away.
      {
        id: 'pay_2',
        date: '2026-03-15',
        total: '5.000.000,5',
        principal: '3.600.000,25',
        interest: '1.400.000,25',
        note: null,
      },
    ])
  })

  it('carries the edit form its own prefill, with no Decimal or Date crossing to the client', () => {
    const dto = toLoanDto(
      row({
        lender: 'Techcombank',
        scheduledPaymentAmount: new Prisma.Decimal('5200000'),
        notes: 'Instalment reset after the rate review',
      }),
      TODAY,
    )

    // Exactly `updateLoanSchema`'s three fields. Everything that defines the
    // loan — principal, currency, rate, start, term, frequency, due date — is
    // deliberately absent: the schema does not contain them, so the edit form
    // has nothing to prefill them with.
    expect(dto.editable).toEqual({
      lender: 'Techcombank',
      // `toFixed(2)`, so the number input round-trips the stored scale.
      scheduledPaymentAmount: '5200000.00',
      notes: 'Instalment reset after the rate review',
    })
    for (const value of Object.values(dto.editable)) {
      expect(typeof value).toBe('string')
    }
  })

  it('empties the edit form fields the loan has no value for', () => {
    const dto = toLoanDto(row({ notes: null }), TODAY)

    // `''`, not `null`: this feeds an `<input>`'s default value, and the schema
    // reads an empty string as "no notes".
    expect(dto.editable.notes).toBe('')
  })

  it('lets nothing but strings, numbers, booleans and nulls cross to a client component', () => {
    const dto = toLoanDto(
      row({
        notes: 'Home loan',
        payments: [payment()],
      }),
      TODAY,
    )

    // `LoanRowActions` is a client component taking a whole `LoanDto`, and
    // neither a `Prisma.Decimal` nor a `Date` can survive that boundary.
    const leaves = leafValues(dto)
    const paths = leaves.map(([path]) => path)

    // First: the walk really reached the nested places a leak would hide in —
    // otherwise the loop below could pass over an empty list and assert
    // nothing at all.
    expect(paths).toContain('dto.nextDueDate')
    expect(paths).toContain('dto.startDate')
    expect(paths).toContain('dto.outstandingPrincipal')
    expect(paths).toContain('dto.interestRateLabel')
    expect(paths).toContain('dto.editable.scheduledPaymentAmount')
    expect(paths).toContain('dto.payments[0].date')
    expect(paths).toContain('dto.payments[0].total')
    expect(paths).toContain('dto.payments[0].principal')
    expect(paths).toContain('dto.payments[0].interest')

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
  })
})

describe('loanSubtotalsByCurrency', () => {
  it('keeps a USD loan and a VND loan as two separate rows', () => {
    const subtotals = loanSubtotalsByCurrency([
      row({ id: 'loan_usd', currency: 'USD', principal: new Prisma.Decimal('20000') }),
      row({ id: 'loan_vnd' }),
    ])

    // The whole reason this function exists: 20.000 USD and 240.000.000 VND is
    // not 240.020.000 of anything, and no FX rate is applied on this page.
    expect(subtotals).toEqual([
      { currency: 'VND', outstandingPrincipal: '240.000.000' },
      { currency: 'USD', outstandingPrincipal: '20.000,00' },
    ])
  })

  it('sums within one currency, on the Decimal', () => {
    const subtotals = loanSubtotalsByCurrency([
      row({ id: 'a', principal: new Prisma.Decimal('240000000.50') }),
      row({ id: 'b', principal: new Prisma.Decimal('60000000.25') }),
    ])

    expect(subtotals).toEqual([{ currency: 'VND', outstandingPrincipal: '300.000.000,75' }])
  })

  it('counts what principal is still outstanding, not what was borrowed', () => {
    const subtotals = loanSubtotalsByCurrency([row({ payments: [payment()] })])

    // 240.000.000 borrowed, 3.500.000 of principal repaid — and the 1.500.000
    // of interest paid alongside it changes this figure by nothing.
    expect(subtotals).toEqual([{ currency: 'VND', outstandingPrincipal: '236.500.000' }])
  })

  it('excludes a closed loan, whatever is nominally still outstanding on it', () => {
    const subtotals = loanSubtotalsByCurrency([
      row({ id: 'live' }),
      row({ id: 'gone', status: 'CLOSED' }, 'CLOSED'),
    ])

    // A closed loan is not a liability any more (the service's `activeOnly`
    // says the same thing for the dashboard), so it must not appear in a total
    // the user reads as "what I still owe".
    expect(subtotals).toEqual([{ currency: 'VND', outstandingPrincipal: '240.000.000' }])
  })

  it('excludes a repaid loan, so a fully settled row adds nothing', () => {
    const subtotals = loanSubtotalsByCurrency([
      row({ id: 'live' }),
      row(
        {
          id: 'settled',
          payments: [
            payment({
              totalAmount: new Prisma.Decimal('240000000'),
              principalAmount: new Prisma.Decimal('240000000'),
              interestAmount: new Prisma.Decimal('0'),
            }),
          ],
        },
        'PAID_OFF',
      ),
    ])

    expect(subtotals).toEqual([{ currency: 'VND', outstandingPrincipal: '240.000.000' }])
  })

  it('returns no rows at all when nothing is outstanding', () => {
    expect(loanSubtotalsByCurrency([])).toEqual([])
    expect(
      loanSubtotalsByCurrency([
        row({ status: 'CLOSED' }, 'CLOSED'),
        row(
          {
            id: 'settled',
            payments: [
              payment({
                totalAmount: new Prisma.Decimal('240000000'),
                principalAmount: new Prisma.Decimal('240000000'),
                interestAmount: new Prisma.Decimal('0'),
              }),
            ],
          },
          'PAID_OFF',
        ),
      ]),
    ).toEqual([])
    // An empty list is what lets the page omit the strip rather than render a
    // row of zeroes.
  })

  it('orders the currencies the same way whatever order the loans arrive in', () => {
    const usd = row({ id: 'loan_usd', currency: 'USD', principal: new Prisma.Decimal('20000') })
    const vnd = row({ id: 'loan_vnd' })

    // A strip that reordered itself as loans were added or repaid would move
    // the figure the user was reading.
    expect(loanSubtotalsByCurrency([usd, vnd]).map((s) => s.currency)).toEqual(['VND', 'USD'])
    expect(loanSubtotalsByCurrency([vnd, usd]).map((s) => s.currency)).toEqual(['VND', 'USD'])
  })
})

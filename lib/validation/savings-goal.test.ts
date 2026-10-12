import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  createSavingsGoalSchema,
  savingsGoalEntrySchema,
  updateSavingsGoalProgressSchema,
  updateSavingsGoalSchema,
} from './savings-goal'

/**
 * What this suite is for is the *copy*, as much as the rules.
 *
 * Every message these schemas produce is rendered verbatim under a form field
 * (`components/goals/goal-form.tsx`), so a Zod default — "Invalid input:
 * expected string, received undefined", "Too small: expected string to have
 * >=1 characters" — reaching a user is a product bug, not a cosmetic one. The
 * `NO_RAW_ZOD_TEXT` case below walks every rejection this suite can provoke and
 * asserts none of them reads like that, which is what makes adding a field
 * without copy fail here rather than in front of a user.
 */

/** The shapes Zod's own messages take, none of which may reach a form. */
const RAW_ZOD_TEXT = /expected|Too small|Too big|Invalid input/i

const VALID = {
  name: 'MacBook Pro',
  targetAmount: 50_000_000,
  currency: 'VND' as const,
  deadline: '2026-12-31',
  note: 'For work',
}

/** Every message a failed parse produced, flattened across fields. */
function messagesFor(schema: ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.message)
}

describe('createSavingsGoalSchema', () => {
  it('accepts a fully specified goal', () => {
    const parsed = createSavingsGoalSchema.parse({ ...VALID, initialContribution: 1_000_000 })

    expect(parsed).toEqual({ ...VALID, initialContribution: 1_000_000 })
  })

  it('accepts a goal with no opening amount, no link, no deadline and no note', () => {
    // The optional fields, all absent: the minimum a user can type.
    const parsed = createSavingsGoalSchema.parse({
      name: 'Emergency fund',
      targetAmount: 100,
      currency: 'USD',
    })

    expect(parsed.initialContribution).toBeUndefined()
    expect(parsed.linkedAccountId).toBeUndefined()
    expect(parsed.deadline).toBeUndefined()
    expect(parsed.note).toBeUndefined()
  })

  it('accepts a linked goal, with no opening amount or a zero one', () => {
    expect(
      createSavingsGoalSchema.parse({ ...VALID, linkedAccountId: 'account_1' }).linkedAccountId,
    ).toBe('account_1')
    expect(
      createSavingsGoalSchema.parse({
        ...VALID,
        linkedAccountId: 'account_1',
        initialContribution: 0,
      }).initialContribution,
    ).toBe(0)
  })

  it('refuses an opening amount on a linked goal, on that field', () => {
    // A linked goal's progress is its account's balance: an opening
    // contribution would be a figure it can never show.
    const result = createSavingsGoalSchema.safeParse({
      ...VALID,
      linkedAccountId: 'account_1',
      initialContribution: 1,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['initialContribution'],
        message: 'A linked goal follows its account balance — leave this empty',
      }),
    ])
  })

  it('trims the name, so a space-only name is not a name', () => {
    expect(createSavingsGoalSchema.parse({ ...VALID, name: '  Car  ' }).name).toBe('Car')
    expect(messagesFor(createSavingsGoalSchema, { ...VALID, name: '   ' })).toEqual([
      'Enter a name',
    ])
  })

  it.each([
    [{ name: '' }, 'Enter a name'],
    [{ name: undefined }, 'Enter a name'],
    [{ name: 'x'.repeat(101) }, 'Keep the name under 100 characters'],
    [{ targetAmount: 0 }, 'Target must be greater than zero'],
    [{ targetAmount: -1 }, 'Target must be greater than zero'],
    [{ targetAmount: undefined }, 'Enter an amount'],
    // An emptied `<input type="number">` with `valueAsNumber` arrives as NaN.
    [{ targetAmount: Number.NaN }, 'Enter an amount'],
    [{ targetAmount: 10.001 }, 'Use at most 2 decimal places'],
    [{ targetAmount: 1e14 }, 'Amount is too large'],
    [{ currency: undefined }, 'Choose a currency'],
    [{ currency: 'EUR' }, 'Choose a currency'],
    [{ initialContribution: -1 }, 'Progress cannot be negative'],
    [{ initialContribution: Number.NaN }, 'Enter an amount'],
    [{ linkedAccountId: '' }, 'Choose an account'],
    [{ linkedAccountId: 42 }, 'Choose an account'],
    [{ deadline: '31/12/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ deadline: '2026-02-30' }, 'Enter a real date'],
    [{ note: 'x'.repeat(501) }, 'Keep the note under 500 characters'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(createSavingsGoalSchema, { ...VALID, ...patch })).toContain(message)
  })

  it('treats an empty deadline as no deadline, not as a malformed one', () => {
    // The case `optionalCalendarDateSchema`'s normalisation exists for: an
    // untouched `<input type="date">` submits `''`, and telling the user to
    // "enter a date as yyyy-MM-dd" in a field they deliberately left blank is
    // wrong. `''` and an absent key mean the same thing and parse the same way.
    expect(createSavingsGoalSchema.parse({ ...VALID, deadline: '' }).deadline).toBeUndefined()
    expect(
      createSavingsGoalSchema.parse({ ...VALID, deadline: undefined }).deadline,
    ).toBeUndefined()
    expect('deadline' in createSavingsGoalSchema.parse({ ...VALID, deadline: '' })).toBe(true)
  })

  it('rejects a non-string deadline with product copy rather than coercing it', () => {
    // `null` is NOT normalised to "no deadline": nothing the form or the typed
    // action input can produce is `null`, so it only ever arrives from a crafted
    // request — and answering it with the same copy every other malformed value
    // gets is more honest than silently dropping the field.
    for (const value of [null, 42, ['2026-01-01']]) {
      expect(messagesFor(createSavingsGoalSchema, { ...VALID, deadline: value })).toEqual([
        'Enter a date as yyyy-MM-dd',
      ])
    }
  })

  it('rejects an impossible deadline rather than rolling it into the next month', () => {
    expect(createSavingsGoalSchema.safeParse({ ...VALID, deadline: '2026-02-30' }).success).toBe(
      false,
    )
    expect(createSavingsGoalSchema.safeParse({ ...VALID, deadline: '2025-02-29' }).success).toBe(
      false,
    )
    // ...but a real leap day is fine.
    expect(createSavingsGoalSchema.parse({ ...VALID, deadline: '2024-02-29' }).deadline).toBe(
      '2024-02-29',
    )
  })

  it('ignores a client-supplied status — it is derived, never posted', () => {
    const parsed = createSavingsGoalSchema.parse({ ...VALID, status: 'ACHIEVED' })

    expect(parsed).not.toHaveProperty('status')
  })
})

describe('updateSavingsGoalSchema', () => {
  it('is the create schema without the opening amount, and takes no progress figure', () => {
    const parsed = updateSavingsGoalSchema.parse({
      ...VALID,
      initialContribution: 999,
      currentProgress: 999,
      progress: 999,
    })

    // Stripped, not honoured: an edit changes the goal's definition and its
    // progress source, never its progress, which moves through entries.
    expect(parsed).not.toHaveProperty('initialContribution')
    expect(parsed).not.toHaveProperty('currentProgress')
    expect(parsed).not.toHaveProperty('progress')
    expect(parsed.targetAmount).toBe(VALID.targetAmount)
  })

  it('carries the progress source: an account id, or nothing for "not linked"', () => {
    expect(
      updateSavingsGoalSchema.parse({ ...VALID, linkedAccountId: 'account_1' }).linkedAccountId,
    ).toBe('account_1')
    expect(updateSavingsGoalSchema.parse(VALID).linkedAccountId).toBeUndefined()
    expect(messagesFor(updateSavingsGoalSchema, { ...VALID, linkedAccountId: '' })).toEqual([
      'Choose an account',
    ])
  })

  it('still enforces every other field', () => {
    expect(messagesFor(updateSavingsGoalSchema, { ...VALID, name: '' })).toContain('Enter a name')
    expect(messagesFor(updateSavingsGoalSchema, { ...VALID, targetAmount: 0 })).toContain(
      'Target must be greater than zero',
    )
  })
})

describe('savingsGoalEntrySchema', () => {
  /** The user's calendar day the schema is built for. */
  const TODAY = '2026-03-12'
  const ENTRY = { kind: 'CONTRIBUTION', amount: 2_000_000, date: TODAY, note: 'Bonus' }

  it('accepts a contribution and a withdrawal, with or without a note, up to today', () => {
    expect(savingsGoalEntrySchema(TODAY).parse(ENTRY)).toEqual(ENTRY)
    expect(
      savingsGoalEntrySchema(TODAY).parse({ kind: 'WITHDRAWAL', amount: 0.01, date: '2024-02-29' }),
    ).toEqual({ kind: 'WITHDRAWAL', amount: 0.01, date: '2024-02-29' })
  })

  it('refuses a date after today, on the date field (ruling P11)', () => {
    // Money put aside tomorrow has not been put aside: a linked goal's balance
    // counts nothing dated after now, and an entry may not either.
    const result = savingsGoalEntrySchema(TODAY).safeParse({ ...ENTRY, date: '2026-03-13' })

    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['date'], message: 'The date cannot be later than today' }),
    ])
    // A date that is not a real day gets its own message only, never a second
    // claim that it lies in the future.
    for (const date of ['soon', '9999-99-99', '2999-02-30']) {
      expect(messagesFor(savingsGoalEntrySchema(TODAY), { ...ENTRY, date })).not.toContain(
        'The date cannot be later than today',
      )
    }
    // The bound is the caller's today, not a clock read inside the schema.
    expect(savingsGoalEntrySchema('2026-03-13').parse({ ...ENTRY, date: '2026-03-13' }).date).toBe(
      '2026-03-13',
    )
  })

  it.each([
    [{ kind: undefined }, 'Choose contribute or withdraw'],
    [{ kind: 'GIFT' }, 'Choose contribute or withdraw'],
    // The sign is the kind, never the number.
    [{ amount: 0 }, 'Amount must be greater than zero'],
    [{ amount: -5 }, 'Amount must be greater than zero'],
    [{ amount: Number.NaN }, 'Enter an amount'],
    [{ amount: 1.005 }, 'Use at most 2 decimal places'],
    [{ date: '' }, 'Enter a date'],
    [{ date: undefined }, 'Enter a date'],
    [{ date: '12/03/2026' }, 'Enter a date as yyyy-MM-dd'],
    [{ date: '2026-02-30' }, 'Enter a real date'],
    [{ note: 'x'.repeat(501) }, 'Keep the note under 500 characters'],
    [{ note: 7 }, 'Enter the note as text'],
  ])('rejects %o with product copy', (patch, message) => {
    expect(messagesFor(savingsGoalEntrySchema(TODAY), { ...ENTRY, ...patch })).toContain(message)
  })
})

describe('updateSavingsGoalProgressSchema (transitional)', () => {
  it('accepts zero and any positive amount, including one over the target', () => {
    expect(updateSavingsGoalProgressSchema.parse({ progress: 0 }).progress).toBe(0)
    expect(updateSavingsGoalProgressSchema.parse({ progress: 999_999_999 }).progress).toBe(
      999_999_999,
    )
  })

  it.each([
    [{ progress: -0.01 }, 'Progress cannot be negative'],
    [{ progress: undefined }, 'Enter an amount'],
    [{ progress: Number.NaN }, 'Enter an amount'],
    [{ progress: 1.234 }, 'Use at most 2 decimal places'],
  ])('rejects %o with product copy', (input, message) => {
    expect(messagesFor(updateSavingsGoalProgressSchema, input)).toContain(message)
  })
})

describe('no raw Zod text can reach the UI', () => {
  /** Every rejection the four schemas can produce from a wrong field, in one
   *  list, so a new field without copy fails this case. */
  const ALL_REJECTIONS: [ZodType, unknown][] = [
    [createSavingsGoalSchema, {}],
    [createSavingsGoalSchema, { ...VALID, name: '' }],
    [createSavingsGoalSchema, { ...VALID, name: null }],
    [createSavingsGoalSchema, { ...VALID, name: 'x'.repeat(101) }],
    [createSavingsGoalSchema, { ...VALID, targetAmount: 0 }],
    [createSavingsGoalSchema, { ...VALID, targetAmount: 'lots' }],
    [createSavingsGoalSchema, { ...VALID, targetAmount: Number.NaN }],
    [createSavingsGoalSchema, { ...VALID, targetAmount: Number.POSITIVE_INFINITY }],
    [createSavingsGoalSchema, { ...VALID, targetAmount: 1.005 }],
    [createSavingsGoalSchema, { ...VALID, currency: 'EUR' }],
    [createSavingsGoalSchema, { ...VALID, currency: 42 }],
    [createSavingsGoalSchema, { ...VALID, initialContribution: -5 }],
    [createSavingsGoalSchema, { ...VALID, linkedAccountId: 'a', initialContribution: 5 }],
    [createSavingsGoalSchema, { ...VALID, linkedAccountId: null }],
    [createSavingsGoalSchema, { ...VALID, deadline: 'soon' }],
    [createSavingsGoalSchema, { ...VALID, deadline: '2026-02-30' }],
    [createSavingsGoalSchema, { ...VALID, deadline: 20261231 }],
    [createSavingsGoalSchema, { ...VALID, deadline: null }],
    [createSavingsGoalSchema, { ...VALID, note: 'x'.repeat(501) }],
    [createSavingsGoalSchema, { ...VALID, note: 7 }],
    [updateSavingsGoalSchema, {}],
    [updateSavingsGoalSchema, { ...VALID, name: '' }],
    [updateSavingsGoalSchema, { ...VALID, deadline: 'nope' }],
    [updateSavingsGoalSchema, { ...VALID, linkedAccountId: '' }],
    [savingsGoalEntrySchema('2026-03-12'), {}],
    [
      savingsGoalEntrySchema('2026-03-12'),
      { kind: 'GIFT', amount: 'lots', date: 20260312, note: 7 },
    ],
    [savingsGoalEntrySchema('2026-03-12'), { kind: 'WITHDRAWAL', amount: 0, date: 'soon' }],
    [savingsGoalEntrySchema('2026-03-12'), { kind: 'WITHDRAWAL', amount: 1, date: '2026-03-13' }],
    [updateSavingsGoalProgressSchema, {}],
    [updateSavingsGoalProgressSchema, { progress: -1 }],
    [updateSavingsGoalProgressSchema, { progress: 'lots' }],
  ]

  it('produces at least one message for every rejection above', () => {
    // Guards the guard: a case that accidentally *passes* would satisfy the
    // regex assertion below vacuously.
    for (const [schema, input] of ALL_REJECTIONS) {
      expect(messagesFor(schema, input).length).toBeGreaterThan(0)
    }
  })

  it('never produces a Zod default message', () => {
    for (const [schema, input] of ALL_REJECTIONS) {
      for (const message of messagesFor(schema, input)) {
        expect(message).not.toMatch(RAW_ZOD_TEXT)
      }
    }
  })
})

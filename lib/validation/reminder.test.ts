import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createReminderSchema } from './reminder'

/**
 * What this suite is for is the *copy* and the two *frequency refines*, in that
 * order.
 *
 * Every message this schema produces is rendered verbatim under a form field
 * (Group 7's reminder form), so a Zod default — "Invalid input: expected number,
 * received NaN", "Too big: expected number to be <=99" — reaching a user is a
 * product bug, not a cosmetic one. The `no raw Zod text` case below walks every
 * rejection this suite can provoke and asserts none of them reads like that.
 *
 * The refines are the other half. `dayOfMonth` and `month` are anchors for a
 * *monthly* or *yearly* schedule and mean nothing on a weekly or one-off one, and
 * an interval other than 1 means nothing on a reminder that happens once. Both
 * are rejected rather than quietly dropped: a user who filled the field in
 * expects it to do something, and silently ignoring it would produce a reminder
 * that fires on a day they did not choose.
 */

/** The shapes Zod's own messages take, none of which may reach a form. */
const RAW_ZOD_TEXT = /expected|Too small|Too big|Invalid input/i

const VALID_REMINDER = {
  title: 'Rent',
  type: 'EXPENSE' as const,
  expectedAmount: 5_000_000,
  currency: 'VND' as const,
  frequency: 'MONTHLY' as const,
  interval: 1,
  dayOfMonth: 1,
  startDate: '2026-01-01',
  note: 'Transfer to the landlord',
}

/** Every message a failed parse produced, flattened across fields. */
function messagesFor(schema: ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.message)
}

/** The messages a failed parse produced for one field. */
function messagesForField(schema: ZodType, input: unknown, field: string): string[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues
    .filter((issue) => issue.path.join('.') === field)
    .map((issue) => issue.message)
}

describe('createReminderSchema', () => {
  it('accepts a fully specified reminder', () => {
    expect(createReminderSchema.parse(VALID_REMINDER)).toEqual(VALID_REMINDER)
  })

  it('accepts the minimum a user can type — no category, account, anchor or note', () => {
    const parsed = createReminderSchema.parse({
      title: 'Salary',
      type: 'INCOME',
      expectedAmount: 20_000_000,
      currency: 'VND',
      frequency: 'WEEKLY',
      interval: 1,
      startDate: '2026-01-05',
    })

    expect(parsed.categoryId).toBeUndefined()
    expect(parsed.accountId).toBeUndefined()
    expect(parsed.dayOfMonth).toBeUndefined()
    expect(parsed.month).toBeUndefined()
    expect(parsed.note).toBeUndefined()
  })

  it('accepts a category and an account id', () => {
    const parsed = createReminderSchema.parse({
      ...VALID_REMINDER,
      categoryId: 'cat_1',
      accountId: 'acc_1',
    })

    expect(parsed.categoryId).toBe('cat_1')
    expect(parsed.accountId).toBe('acc_1')
  })

  it('trims the title and strips keys the client must not set', () => {
    const parsed = createReminderSchema.parse({
      ...VALID_REMINDER,
      title: '  Rent  ',
      // `active` is set only by `setReminderActive`, `userId` only by the
      // session, and neither may be overridden by a crafted request body.
      active: false,
      userId: 'someone-else',
    })

    expect(parsed.title).toBe('Rent')
    expect(parsed).not.toHaveProperty('active')
    expect(parsed).not.toHaveProperty('userId')
  })

  describe('field copy', () => {
    it.each([
      [{ title: '' }, 'title', 'Enter a title'],
      [{ title: '   ' }, 'title', 'Enter a title'],
      [{ title: undefined }, 'title', 'Enter a title'],
      [{ title: 'x'.repeat(101) }, 'title', 'Keep the title under 100 characters'],
      [{ type: undefined }, 'type', 'Choose income or expense'],
      [{ type: 'TRANSFER' }, 'type', 'Choose income or expense'],
      [{ expectedAmount: undefined }, 'expectedAmount', 'Enter an amount'],
      // An emptied `<input type="number">` registered with `valueAsNumber`
      // arrives as NaN — the most reachable failure this field has.
      [{ expectedAmount: Number.NaN }, 'expectedAmount', 'Enter an amount'],
      [{ expectedAmount: 0 }, 'expectedAmount', 'Amount must be greater than zero'],
      [{ expectedAmount: -1 }, 'expectedAmount', 'Amount must be greater than zero'],
      [{ expectedAmount: 1.234 }, 'expectedAmount', 'Use at most 2 decimal places'],
      [{ currency: undefined }, 'currency', 'Choose a currency'],
      [{ currency: 'EUR' }, 'currency', 'Choose a currency'],
      [{ categoryId: '' }, 'categoryId', 'Choose a category'],
      [{ accountId: '' }, 'accountId', 'Choose an account'],
      [{ frequency: undefined }, 'frequency', 'Choose how often'],
      [{ frequency: 'DAILY' }, 'frequency', 'Choose how often'],
      [{ interval: undefined }, 'interval', 'Enter how often it repeats'],
      [{ interval: Number.NaN }, 'interval', 'Enter how often it repeats'],
      [{ interval: 1.5 }, 'interval', 'Whole numbers only'],
      [{ interval: 0 }, 'interval', 'At least every 1'],
      [{ interval: -1 }, 'interval', 'At least every 1'],
      [{ interval: 100 }, 'interval', 'At most every 99'],
      [{ dayOfMonth: 0 }, 'dayOfMonth', 'Pick a day from 1 to 31'],
      [{ dayOfMonth: 32 }, 'dayOfMonth', 'Pick a day from 1 to 31'],
      [{ dayOfMonth: 1.5 }, 'dayOfMonth', 'Whole numbers only'],
      [{ frequency: 'YEARLY', month: 0 }, 'month', 'Pick a month from 1 to 12'],
      [{ frequency: 'YEARLY', month: 13 }, 'month', 'Pick a month from 1 to 12'],
      [{ startDate: '' }, 'startDate', 'Enter a start date'],
      [{ startDate: undefined }, 'startDate', 'Enter a start date'],
      [{ startDate: '01/01/2026' }, 'startDate', 'Enter a date as yyyy-MM-dd'],
      // Right shape, no such day — the value a parser would roll over into
      // 2 March, storing a start date the user never picked.
      [{ startDate: '2026-02-30' }, 'startDate', 'Enter a real date'],
      [{ note: 'x'.repeat(501) }, 'note', 'Keep the note under 500 characters'],
      [{ note: 42 }, 'note', 'Enter the note as text'],
    ])('reports product copy for %o', (patch, field, message) => {
      expect(
        messagesForField(createReminderSchema, { ...VALID_REMINDER, ...patch }, field),
      ).toContain(message)
    })

    it('never leaks raw Zod text for any rejection this suite can provoke', () => {
      const patches: Record<string, unknown>[] = [
        {},
        { title: '' },
        { title: 42 },
        { title: 'x'.repeat(101) },
        { type: 'TRANSFER' },
        { type: null },
        { expectedAmount: Number.NaN },
        { expectedAmount: 0 },
        { expectedAmount: 1.234 },
        { expectedAmount: 1e14 },
        { expectedAmount: 'lots' },
        { currency: 'EUR' },
        { categoryId: '' },
        { categoryId: 7 },
        { accountId: '' },
        { accountId: 7 },
        { frequency: 'DAILY' },
        { interval: Number.NaN },
        { interval: 0 },
        { interval: 100 },
        { interval: 1.5 },
        { interval: 'two' },
        { dayOfMonth: 0 },
        { dayOfMonth: 32 },
        { dayOfMonth: 'first' },
        { frequency: 'YEARLY', month: 13 },
        { frequency: 'YEARLY', month: 'March' },
        { startDate: '' },
        { startDate: '01/01/2026' },
        { startDate: '2026-02-30' },
        { startDate: 42 },
        { note: 'x'.repeat(501) },
        { note: 42 },
        { frequency: 'WEEKLY', dayOfMonth: 1 },
        { frequency: 'ONE_TIME', month: 3 },
        { frequency: 'ONE_TIME', dayOfMonth: undefined, interval: 2 },
        // Every field missing at once — the shape a completely empty submit or a
        // crafted empty body produces.
        {
          title: undefined,
          type: undefined,
          expectedAmount: undefined,
          currency: undefined,
          frequency: undefined,
          interval: undefined,
          dayOfMonth: undefined,
          startDate: undefined,
        },
      ]

      for (const patch of patches) {
        for (const message of messagesFor(createReminderSchema, { ...VALID_REMINDER, ...patch })) {
          expect(message, `patch ${JSON.stringify(patch)}`).not.toMatch(RAW_ZOD_TEXT)
        }
      }
    })
  })

  describe('frequency refines', () => {
    it.each(['WEEKLY', 'ONE_TIME'] as const)(
      'rejects a dayOfMonth on %s as not applicable',
      (frequency) => {
        expect(
          messagesForField(
            createReminderSchema,
            { ...VALID_REMINDER, frequency, interval: 1, dayOfMonth: 15 },
            'dayOfMonth',
          ),
        ).toEqual(['Not applicable for this frequency'])
      },
    )

    it.each(['WEEKLY', 'ONE_TIME'] as const)(
      'rejects a month on %s as not applicable',
      (frequency) => {
        expect(
          messagesForField(
            createReminderSchema,
            { ...VALID_REMINDER, frequency, interval: 1, dayOfMonth: undefined, month: 3 },
            'month',
          ),
        ).toEqual(['Not applicable for this frequency'])
      },
    )

    it('accepts both anchors on MONTHLY and on YEARLY', () => {
      expect(
        createReminderSchema.parse({ ...VALID_REMINDER, frequency: 'MONTHLY', dayOfMonth: 31 })
          .dayOfMonth,
      ).toBe(31)
      const yearly = createReminderSchema.parse({
        ...VALID_REMINDER,
        frequency: 'YEARLY',
        dayOfMonth: 25,
        month: 12,
      })
      expect(yearly.dayOfMonth).toBe(25)
      expect(yearly.month).toBe(12)
    })

    it('accepts WEEKLY and ONE_TIME with both anchors simply absent', () => {
      expect(
        createReminderSchema.parse({
          ...VALID_REMINDER,
          frequency: 'WEEKLY',
          dayOfMonth: undefined,
        }).frequency,
      ).toBe('WEEKLY')
      expect(
        createReminderSchema.parse({
          ...VALID_REMINDER,
          frequency: 'ONE_TIME',
          interval: 1,
          dayOfMonth: undefined,
        }).frequency,
      ).toBe('ONE_TIME')
    })

    it('requires an interval of 1 for ONE_TIME', () => {
      expect(
        messagesForField(
          createReminderSchema,
          { ...VALID_REMINDER, frequency: 'ONE_TIME', dayOfMonth: undefined, interval: 2 },
          'interval',
        ),
      ).toEqual(['A one-time reminder happens once — leave this at 1'])
    })

    it('allows an interval above 1 for every recurring frequency', () => {
      for (const frequency of ['WEEKLY', 'MONTHLY', 'YEARLY'] as const) {
        const parsed = createReminderSchema.parse({
          ...VALID_REMINDER,
          frequency,
          dayOfMonth: frequency === 'WEEKLY' ? undefined : 1,
          interval: 3,
        })
        expect(parsed.interval).toBe(3)
      }
    })

    it('reports both anchor problems at once rather than one at a time', () => {
      // Two separate fields the user filled in, so both need to be marked —
      // fixing one and resubmitting only to be told about the other is the
      // failure mode a single early-aborting refine produces.
      const result = createReminderSchema.safeParse({
        ...VALID_REMINDER,
        frequency: 'WEEKLY',
        dayOfMonth: 15,
        month: 3,
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
        'dayOfMonth',
        'month',
      ])
    })
  })
})

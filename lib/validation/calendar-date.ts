import { z } from 'zod'
import { CALENDAR_DATE_RE, isRealCalendarDate } from '@/lib/datetime/calendar-date'

/**
 * The shared `yyyy-MM-dd` field rule, for every Phase 6 planning date — a
 * savings goal's deadline, a debt's due date, a loan's dates.
 *
 * Its own module rather than a field inside `savings-goal.ts` so the later
 * groups reuse the exact same rule and the exact same copy: a deadline and a
 * due date must not fail differently for the same typo. No Prisma import, for
 * the reason `lib/validation/budget.ts` gives — a form's `zodResolver` imports
 * this straight into the browser bundle.
 *
 * Two checks, because they catch different mistakes and need different copy:
 * the regex catches a value that is not a date at all (a stray URL param, a
 * `<input type="text">` fallback in a browser with no date picker), and the
 * refine catches `2026-02-30` — right shape, no such day, and the one a parser
 * would silently roll over into 2 March.
 */
export const calendarDateStringSchema = z
  // The `error` param covers the reachable non-string cases too — `undefined`
  // for a missing key, a `string[]` from a repeated query key — which would
  // otherwise render Zod's own "Invalid input: expected string, received
  // undefined" straight into the form.
  .string({ error: 'Enter a date as yyyy-MM-dd' })
  .regex(CALENDAR_DATE_RE, 'Enter a date as yyyy-MM-dd')
  .refine(isRealCalendarDate, 'Enter a real date')

/**
 * The same rule for a field the user may leave blank.
 *
 * An untouched `<input type="date">` submits `''`, not `undefined`, so without
 * the normalisation below an optional deadline would fail the regex on every
 * submit of a form the user simply did not fill that field in on — and the
 * message ("Enter a date as yyyy-MM-dd") would be advice about a field they
 * deliberately left empty. `''` therefore means "no date", which is exactly
 * what `undefined` means to the service, so it is normalised here rather than
 * in each form's submit handler.
 *
 * Written as `z.string().optional().transform(…).pipe(…)` rather than the
 * shorter `z.preprocess((v) => (v === '' ? undefined : v), …)`, for a typing
 * reason that shows up in the form and nowhere else. `z.preprocess` types its
 * *input* as `unknown`, so `z.input<typeof createSavingsGoalSchema>['deadline']`
 * would be `unknown` — and that is precisely the type
 * `zodResolver`'s `Resolver<z.input<S>, …>` forces onto `useForm`'s field
 * values (`node_modules/@hookform/resolvers/zod/dist/zod.d.ts:49-50`), leaving
 * the goal form with an `unknown`-typed field react-hook-form cannot usefully
 * type. Fronting the pipe with a real `z.string()` keeps the input type
 * `string | undefined`, which is what the date input actually submits, and the
 * key optional on both sides.
 *
 * Fronting it with `z.string({ error })` rather than a union is also what keeps
 * the copy intact: `z.union([z.literal(''), …])` reports Zod's own bare
 * "Invalid input" for a non-string, which
 * `lib/validation/savings-goal.test.ts`'s "no raw Zod text" case forbids.
 * Here a non-string — `null`, a number, a repeated query key's array — gets
 * "Enter a date as yyyy-MM-dd" like any other malformed value.
 */
export const optionalCalendarDateSchema = z
  .string({ error: 'Enter a date as yyyy-MM-dd' })
  .optional()
  .transform((value) => (value === '' ? undefined : value))
  .pipe(calendarDateStringSchema.optional())

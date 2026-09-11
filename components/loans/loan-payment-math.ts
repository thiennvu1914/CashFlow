import type { FieldPath, Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { recordLoanPaymentSchema, type RecordLoanPaymentInput } from '@/lib/validation/loan'

/**
 * The loan payment dialog's pure arithmetic and its RHF resolver — split out of
 * `loan-row-actions.tsx` (Phase 8 pre-flight A-9) so "the loan row's payment
 * arithmetic" has one home instead of sitting in the middle of three React
 * components. Nothing here renders; `loan-payment-form.tsx` is the component
 * that uses it.
 */

/**
 * A monetary value in exact cents — the same function, and the same reasoning,
 * as `lib/validation/loan.ts`'s: `0.29 * 100` is 28.999999999999996, so a
 * float comparison of a split would fail on values that are exactly right.
 * `Math.round` removes only that representation error.
 */
const cents = (value: number) => Math.round(value * 100)

/**
 * The instalment total, derived from its two parts rather than typed.
 *
 * `null` when either part is missing or not a number — an emptied number field
 * arrives as `NaN` through `valueAsNumber` — because a total of "0" for a form
 * the user has not filled in would state a figure nobody entered. This is the
 * value that is SUBMITTED (via `paymentResolver`, below); `displayTotal` is
 * what the read-only field SHOWS while the user is still typing, and the two
 * deliberately differ — see its own doc comment.
 *
 * Added in exact cents and divided back, so 3.500.000,01 + 1.499.999,99 is
 * 5.000.000 and not 5.000.000,0000001.
 */
export function totalFromParts(principal: number, interest: number): number | null {
  if (!Number.isFinite(principal) || !Number.isFinite(interest)) return null
  return (cents(principal) + cents(interest)) / 100
}

/**
 * What the read-only Tổng field SHOWS while the user is still typing.
 *
 * `totalFromParts` answers `null` when a part is not a finite number, which is
 * right for validation and wrong for a field the user is watching: a dash
 * where a number should be reads as "this is broken" the moment they clear one
 * box to retype it. So a blank part counts as zero for DISPLAY only — the
 * submitted `total` still comes from `totalFromParts`, and
 * `createLoanPaymentSchema`'s split refine is still the authority on whether
 * gốc + lãi = tổng.
 */
export function displayTotal(principal: number, interest: number): number {
  const safe = (value: number) => (Number.isFinite(value) ? value : 0)
  return safe(principal) + safe(interest)
}

/**
 * `register`'s `deps`, naming the field the two parts *derive* — without which
 * the total's error goes stale and stays on screen under a field the user
 * cannot type in.
 *
 * `useForm` here takes no `reValidateMode`, so after the first submit
 * re-validation runs on change. `createFormControl`'s change handler does run
 * the whole resolver for every keystroke, but it then updates only the changed
 * field's error: it narrows the fresh error set with `schemaErrorLookup` for
 * `name` and hands the single result to `shouldRenderByError`. `totalAmount` is
 * not a registered field, so no keystroke is ever *that* field changing and its
 * error would only be recomputed by the next submit — leaving "Enter an amount"
 * (or "Amount must be greater than zero", or "Amount is too large") under a
 * Total that has since become correct.
 *
 * `deps` is the hook for exactly this. In the same change handler, immediately
 * before `shouldRenderByError`, RHF calls `trigger(field._f.deps)` whenever the
 * field declares them; with a resolver, `trigger` delegates to
 * `executeSchemaAndUpdateState(names)`, which re-runs the resolver and then,
 * per name, either `set`s the fresh error or **`unset`s** it — and it reads the
 * name out of the resolver's errors rather than out of `_fields`, which is what
 * makes it work for an unregistered field. It finishes with
 * `_subjects.state.next({ errors })`, so the form re-renders with the total's
 * error gone. (Verified in the installed react-hook-form 7.87 source; named by
 * mechanism rather than by line number, which the next bump would invalidate.)
 */
export const DERIVED_FIELD: FieldPath<RecordLoanPaymentInput>[] = ['totalAmount']

const validatePayment = zodResolver(recordLoanPaymentSchema)

/**
 * `recordLoanPaymentSchema`, with the total supplied by the form instead of by
 * the user.
 *
 * The user types the split — what came off the principal and what the loan
 * cost — and the total is arithmetic, so asking for it as a third number would
 * be asking them to do a sum the form can do exactly. Deriving it here, in the
 * resolver, is what makes the figure shown read-only above the fields *the same
 * number* that is validated and then submitted: `handleSubmit` hands `onValid`
 * the resolver's output, not the raw form values
 * (`react-hook-form/dist/index.esm.mjs:3217-3219`, `fieldValues =
 * cloneObject(values)`), so there is one derivation and no second copy to drift.
 *
 * The split invariant's three layers all still stand, and none of them is
 * weakened by this:
 *
 * 1. **Zod** — the `.refine` in `recordLoanPaymentSchema` compares
 *    `cents(total)` with `cents(principal) + cents(interest)`. It runs on the
 *    derived value below and so cannot fire *from this form*, which is the
 *    point: the user is never told off for arithmetic the form did. It remains
 *    layer one for every other caller, and `loan-actions.ts` parses with the
 *    same schema before the service is reached.
 * 2. **The service** re-checks the equality in `Prisma.Decimal` inside the
 *    locked transaction, because float-derived integers are not what the
 *    database will check.
 * 3. **`LoanPayment_total_matches_split`**, the CHECK constraint, is the last
 *    line — it answers a direct insert that bypassed both layers above.
 *
 * The one thing it does post-process is the duplicate message a blank part
 * produces — see `dropDuplicateTotalError`.
 */
export const paymentResolver: Resolver<RecordLoanPaymentInput> = async (
  values,
  context,
  options,
) => {
  const result = await validatePayment(
    {
      ...values,
      // `NaN` when a part is missing, which `moneyAmountSchema` rejects — the
      // duplicate the helper below then removes.
      totalAmount: totalFromParts(values.principalAmount, values.interestAmount) ?? NaN,
    },
    context,
    options,
  )
  return dropDuplicateTotalError(result, values)
}

/**
 * Removes the total's error when it is only an echo of a blank part.
 *
 * A missing part makes the derived total `NaN`, and the schema rejects that
 * with the very same "Enter an amount" it has already put under the part
 * itself. One mistake, reported twice, the second time under a `readOnly` field
 * the user cannot act on — so the second copy is dropped, and the Total field
 * shows `displayTotal`'s zero-for-blank figure instead.
 *
 * The guard is structural rather than argued: the error is removed only while
 * at least one *other* error survives to block the submit. That matters because
 * `handleSubmit` calls `onValid` as soon as the error set is empty, with
 * `zodResolver`'s failure `values` — which is `{}` — so an empty-by-subtraction
 * error set would submit an empty instalment. (Today a non-finite part always
 * carries its own error, so the guard can never fire; it is here so that stays
 * true if the part schemas are ever reworded.)
 */
function dropDuplicateTotalError(
  result: Awaited<ReturnType<typeof validatePayment>>,
  values: RecordLoanPaymentInput,
): Awaited<ReturnType<typeof validatePayment>> {
  const bothPartsPresent =
    Number.isFinite(values.principalAmount) && Number.isFinite(values.interestAmount)
  if (bothPartsPresent) return result

  const { totalAmount, ...others } = result.errors
  if (!totalAmount || Object.keys(others).length === 0) return result
  return { values: {}, errors: others }
}

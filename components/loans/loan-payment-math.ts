import type { FieldPath, Resolver, ResolverResult } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { recordLoanPaymentSchemaAsOf, type RecordLoanPaymentInput } from '@/lib/validation/loan'

/**
 * The loan payment dialog's pure arithmetic and its RHF resolver — split out of
 * `loan-row-actions.tsx` (Phase 8 pre-flight A-9) so "the loan row's payment
 * arithmetic" has one home instead of sitting in the middle of three React
 * components. Nothing here renders; `loan-payment-form.tsx` is the component
 * that uses it.
 *
 * The user types the TOTAL they paid (pre-filled with the scheduled instalment)
 * and the INTEREST that was part of it; the principal is what is left. That is
 * how a statement reads — "the instalment is 5.000.000, of which 1.500.000 is
 * interest" — and it makes the schema's `total = principal + interest` hold by
 * construction.
 */

/**
 * A monetary value in exact cents — the same function, and the same reasoning,
 * as `lib/validation/loan.ts`'s: `0.29 * 100` is 28.999999999999996, so a
 * float comparison of a split would fail on values that are exactly right.
 * `Math.round` removes only that representation error.
 */
const cents = (value: number) => Math.round(value * 100)

/**
 * The instalment's principal, derived from what the user typed: the total they
 * paid minus the interest that was part of it.
 *
 * `null` when either figure is missing or not a number — an emptied number
 * field arrives as `NaN` through `valueAsNumber` — because a principal of "0"
 * for a form the user has not filled in would state a figure nobody entered.
 * This is the value that is SUBMITTED (via `paymentResolverAsOf`, below);
 * `displayPrincipal` is what the read-only field SHOWS while the user is still
 * typing, and the two deliberately differ — see its own doc comment.
 *
 * Subtracted in exact cents and divided back, so 1.000.000,30 − 0,20 is
 * 1.000.000,10 and not 1.000.000,0999999999. Negative when the interest is more
 * than the total: the schema refuses that on the principal.
 */
export function principalFromParts(total: number, interest: number): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(interest)) return null
  return (cents(total) - cents(interest)) / 100
}

/**
 * What the read-only Gốc field SHOWS while the user is still typing.
 *
 * `principalFromParts` answers `null` when a figure is not a number, which is
 * right for validation and wrong for a field the user is watching: a dash where
 * a number should be reads as "this is broken" the moment they clear one box to
 * retype it. So a blank figure counts as zero for DISPLAY only — the submitted
 * principal still comes from `principalFromParts`. It is also what makes the
 * dialog read sensibly the moment it opens: the total is pre-filled with the
 * scheduled instalment and the interest is blank, so Gốc starts as the whole
 * total.
 *
 * Interest-only instalments (principal 0) are ordinary: with the interest equal
 * to the total this is exactly 0. A negative result is shown as it is — the
 * interest typed is more than the total — and the schema's refusal appears
 * under the same field.
 */
export function displayPrincipal(total: number, interest: number): number {
  const safe = (value: number) => (Number.isFinite(value) ? value : 0)
  return (cents(safe(total)) - cents(safe(interest))) / 100
}

/**
 * `register`'s `deps`, naming the field the two typed amounts *derive* — without
 * which the principal's error goes stale and stays on screen under a field the
 * user cannot type in.
 *
 * `useForm` here takes no `reValidateMode`, so after the first submit
 * re-validation runs on change. `createFormControl`'s change handler does run
 * the whole resolver for every keystroke, but it then updates only the changed
 * field's error: it narrows the fresh error set with `schemaErrorLookup` for
 * `name` and hands the single result to `shouldRenderByError`. `principalAmount`
 * is not a registered field, so no keystroke is ever *that* field changing and
 * its error would only be recomputed by the next submit — leaving "The principal
 * cannot be negative" under a Gốc that has since become correct.
 *
 * `deps` is the hook for exactly this. In the same change handler, immediately
 * before `shouldRenderByError`, RHF calls `trigger(field._f.deps)` whenever the
 * field declares them; with a resolver, `trigger` delegates to
 * `executeSchemaAndUpdateState(names)`, which re-runs the resolver and then,
 * per name, either `set`s the fresh error or **`unset`s** it — and it reads the
 * name out of the resolver's errors rather than out of `_fields`, which is what
 * makes it work for an unregistered field. It finishes with
 * `_subjects.state.next({ errors })`, so the form re-renders with the error
 * gone. (Verified in the installed react-hook-form 7.87 source; named by
 * mechanism rather than by line number, which the next bump would invalidate.)
 */
export const DERIVED_FIELD: FieldPath<RecordLoanPaymentInput>[] = ['principalAmount']

/**
 * `recordLoanPaymentSchemaAsOf(today)`, with the principal supplied by the form
 * instead of by the user. `today` is the user's own calendar day from the page
 * (profile zone): an instalment paid from an account cannot be dated later
 * (Ruling P12), so the resolver is built per form for that day.
 *
 * The user types the total and the interest, and the principal is arithmetic,
 * so asking for it as a third number would be asking them to do a subtraction
 * the form can do exactly. Deriving it here, in the resolver, is what makes the
 * figure shown read-only in the dialog *the same number* that is validated and
 * then submitted: `handleSubmit` hands `onValid` the resolver's output, not the
 * raw form values, so there is one derivation and no second copy to drift.
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
 * produces — see `dropDuplicatePrincipalError`.
 */
export function paymentResolverAsOf(today: string): Resolver<RecordLoanPaymentInput> {
  const validatePayment = zodResolver(recordLoanPaymentSchemaAsOf(today))
  return async (values, context, options) => {
    const result = await validatePayment(
      {
        ...values,
        // `NaN` when a part is missing, which `moneyAmountSchema` rejects — the
        // duplicate the helper below then removes.
        principalAmount: principalFromParts(values.totalAmount, values.interestAmount) ?? NaN,
      },
      context,
      options,
    )
    return dropDuplicatePrincipalError(result, values)
  }
}

/**
 * Removes the principal's error when it is only an echo of a blank part.
 *
 * A missing total or interest makes the derived principal `NaN`, and the schema
 * rejects that with the very same "Enter an amount" it has already put under
 * the blank field itself. One mistake, reported twice, the second time under a
 * `readOnly` field the user cannot act on — so the second copy is dropped, and
 * the Gốc field shows `displayPrincipal`'s zero-for-blank figure instead.
 *
 * The guard is structural rather than argued: the error is removed only while
 * at least one *other* error survives to block the submit. That matters because
 * `handleSubmit` calls `onValid` as soon as the error set is empty, with
 * `zodResolver`'s failure `values` — which is `{}` — so an empty-by-subtraction
 * error set would submit an empty instalment. (Today a non-finite part always
 * carries its own error, so the guard can never fire; it is here so that stays
 * true if the part schemas are ever reworded.)
 */
function dropDuplicatePrincipalError(
  result: ResolverResult<RecordLoanPaymentInput>,
  values: RecordLoanPaymentInput,
): ResolverResult<RecordLoanPaymentInput> {
  const bothPartsPresent =
    Number.isFinite(values.totalAmount) && Number.isFinite(values.interestAmount)
  if (bothPartsPresent) return result

  const { principalAmount, ...others } = result.errors
  if (!principalAmount || Object.keys(others).length === 0) return result
  return { values: {}, errors: others }
}

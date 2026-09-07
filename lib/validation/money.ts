import { z } from 'zod'

/**
 * Every money column in this schema is `Decimal(18, 2)` — exactly 2
 * fractional digits — so a value with more would silently be rounded by
 * Postgres rather than rejected. The invariant this project holds is that
 * money is never rounded without the user asking for it, so this check has
 * to catch a sub-cent fraction itself.
 *
 * `String(value)` is JavaScript's shortest round-trip decimal representation
 * — the same representation `@prisma/adapter-pg` uses when it serialises a
 * JS `number` into a `DECIMAL` literal — so checking it is magnitude
 * independent and matches what actually gets written to the database.
 * `toFixed(n)` was tried first and rejected: it re-renders the float at a
 * *fixed* precision and introduces its own rounding artefacts above roughly
 * 1e7 (`(10000000.45).toFixed(10)` → `"10000000.4499999993"`), which falsely
 * failed valid 2-decimal amounts once the balance got large.
 */
export function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false
  const s = String(value) // shortest round-trip repr, e.g. "1234567890123.45", "0.29", "1.005"
  if (s.includes('e')) return false // exponent form: either beyond the magnitude cap or a sub-cent fraction like 1e-7
  const frac = s.split('.')[1]
  return frac === undefined || frac.length <= 2
}

// Decimal(18, 2) can hold up to 16 integer digits, but the binding limit is
// the double these amounts travel in, not the column: a JS number stops being
// able to represent every 2-decimal value exactly at around 9e13
// (`Number.MAX_SAFE_INTEGER / 100`), above which `x.99` silently rounds to a
// neighbouring value before Zod or Postgres ever sees it. The cap is set an
// order of magnitude below that, which still leaves room for ~10 trillion VND
// — far beyond any personal balance this app is for.
export const MAX_MONEY_MAGNITUDE = 1e13

/**
 * Shared money-amount schema for every Zod object that accepts a monetary
 * amount. Lives in its own module with no Prisma import so a client
 * component's `zodResolver` can import it directly alongside a server
 * service.
 *
 * The `error` param is what keeps this field's most reachable failure readable.
 * Every amount input registers with react-hook-form's `valueAsNumber`, so an
 * *emptied* number field arrives here as `NaN` — and Zod 4's base number check
 * rejects `NaN`, `±Infinity`, `undefined` and non-numbers itself, before
 * `.finite()` or either refine below is reached. Without the param those all
 * render as "Invalid input: expected number, received NaN".
 *
 * The copy is deliberately generic: this schema backs the transaction,
 * transfer, account and budget amount fields, so it has to read correctly under
 * every one of them. A per-field wording would have to go on those fields
 * rather than here.
 */
export const moneyAmountSchema = z
  .number({ error: 'Enter an amount' })
  // Redundant against Zod 4's base check (which already rejects a non-finite
  // number), and kept only so this stays true of the schema on its own terms.
  .finite()
  .refine((v) => Math.abs(v) < MAX_MONEY_MAGNITUDE, 'Amount is too large')
  .refine(hasAtMostTwoDecimalPlaces, 'Use at most 2 decimal places')

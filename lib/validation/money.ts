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

// Decimal(18, 2) can hold up to 16 integer digits; capping the magnitude well
// under that keeps every accepted value representable without depending on
// Postgres to reject an overflow after the fact.
export const MAX_MONEY_MAGNITUDE = 1e15

/**
 * Shared money-amount schema for every Zod object that accepts a monetary
 * amount. Lives in its own module with no Prisma import so a client
 * component's `zodResolver` can import it directly alongside a server
 * service.
 */
export const moneyAmountSchema = z
  .number()
  .finite()
  .refine((v) => Math.abs(v) < MAX_MONEY_MAGNITUDE, 'Amount is too large')
  .refine(hasAtMostTwoDecimalPlaces, 'Use at most 2 decimal places')

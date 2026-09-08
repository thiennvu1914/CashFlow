/**
 * The bridge between the Zod schemas' English literals and their Vietnamese
 * renderings (spec §4).
 *
 * The schemas do NOT change. Their messages are asserted by Phase 2–6 tests,
 * they are re-produced server-side on every submit, and moving message text
 * into the validation layer would be exactly the semantics change this phase
 * forbids. So the literal *is* the key, and the translation happens where the
 * message is rendered — in `FieldError`.
 *
 * Two escaping problems make this a function rather than a template literal at
 * each call site:
 *
 *  1. next-intl reads `.` as a path separator, so "Total must equal principal
 *     plus interest." would look up `validation.Total must equal principal plus
 *     interest` → `''` and find nothing. Dots become `\u2024` (ONE DOT LEADER),
 *     a character no schema message contains.
 *  2. A message may contain `{` or `}` (none does today), which ICU would read
 *     as an argument. Those are stripped from the KEY, and the value in
 *     `validation.json` is what carries the readable text.
 *
 * `messages/{vi,en}/validation.json` is therefore keyed by the ESCAPED literal,
 * and `validation-messages.test.ts` is what keeps the two in step.
 */
const DOT = '\u2024'

export function validationMessageKey(message: string): string {
  return `validation.${message.replaceAll('.', DOT).replaceAll('{', '').replaceAll('}', '')}`
}

/**
 * Every shape a Zod message takes in `lib/validation/**`, as of Phase 7:
 *
 *   z.string().min(1, 'Name is required')          → the 2nd argument
 *   z.number({ error: 'Enter an amount' })          → the `error:` property
 *   .refine(fn, 'Enter a valid IANA timezone, e.g. Asia/Ho_Chi_Minh')
 *                                                    → the 2nd argument
 *   .refine(fn, { message: 'Total must equal principal plus interest', … })
 *                                                    → the `message:` property
 *   z.enum([...], { error: 'Choose a type' })       → the `error:` property
 *   z.email('Enter a valid email address')          → the sole argument
 *   .int('Whole numbers only')                      → the sole argument
 *
 * Adapted from the brief's original single-branch pattern
 * (`/(?:,\s*|error:\s*)'(?<message>[^'\\]{4,120})'/g`), which both under- and
 * over-matched against the real files:
 *
 *  - it MISSED every sole-argument call (`z.email(...)`, `.int(...)`), because
 *    neither is preceded by a comma or `error:`;
 *  - it MISSED the `message: 'X', path: [...]` object-literal shape used by
 *    every multi-field `.refine()` (budget, transaction, transfer, reminder,
 *    loan) — nothing in the original pattern reads a `message:` property;
 *  - it OVER-MATCHED every `z.enum([...])`/`new Set([...])` array literal of
 *    two or more members: the second element onward (`'PAYABLE'`, `'CATEGORY'`,
 *    `'MONTHLY'`, …) sits right after a comma too, and the original pattern
 *    cannot tell "a message after a comma" from "an enum member after a
 *    comma";
 *  - it OVER-MATCHED `Omit<ProfileInput, 'name'>` — a *type-level* string
 *    literal, not a runtime message, that also happens to follow a comma.
 *
 * This pattern fixes both over-matches with one rule: a comma-, `message:`- or
 * `error:`-prefixed literal is a candidate ONLY if the character immediately
 * before that comma/keyword is not itself a closing quote — which is exactly
 * what separates ".min(1, 'X')" (preceded by a digit) from "['A', 'B']"
 * (preceded by the `'` that closes `'A'`). The sole-argument shape is instead
 * recognised by name (`email(`/`int(`) rather than by "any `(` immediately
 * followed by a quote", because the latter also matches `new
 * Intl.DateTimeFormat('en-US', …)` inside `isValidIanaTimezone` — a locale
 * code, not a user-facing message. A minimum length of 10 excludes the one
 * remaining false positive (`Omit<ProfileInput, 'name'>`'s `'name'`, 4
 * characters) while keeping every genuine message, whose shortest is 12.
 *
 * Deliberately conservative even so: it will still miss a message written as
 * a template literal or built from a variable. The test's canary assertions
 * are what surface that — a regex that silently finds nothing is worse than
 * one that finds too much, and the fix for a missed shape is this pattern.
 *
 * Built via the `RegExp` constructor from a string rather than as a regex
 * literal: this project's `tsconfig.json` targets ES2017, and `tsc` refuses a
 * literal containing `(?<name>…)` below ES2018 (`TS1503`) even though Node
 * itself has supported named groups since ES2018 regardless of that target —
 * the target only governs what *syntax* `tsc` lets a literal use, not what the
 * runtime executing the emitted JS supports. A string is just a string to the
 * type checker, so this sidesteps the restriction without touching the
 * project-wide `target`.
 */
export const ZOD_MESSAGE_PATTERN: RegExp = new RegExp(
  String.raw`(?:\b(?:email|int)\(\s*|(?<!')(?:,\s*|message:\s*|error:\s*))'(?<message>[^'\\]{10,200})'`,
  'g',
)

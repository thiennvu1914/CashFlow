# CashFlow Phase 3: FX Aggregation Helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `historicalAmountIn` (for reporting/budgets) and `convertToCurrentAmount` (for position metrics) exist and are unit-tested in isolation, ready for Phase 4 to consume.

**Architecture:** The FX trust center itself — `ExchangeRateProvider`, the cache, `getUsableCurrentRate` — was moved into Phase 2 and built before Transactions became usable, since a Transaction's FX snapshot is an immutable historical fact that must never be fabricated. This phase covers only what's left: the pure aggregation math that turns already-snapshotted Transaction rows (or live rates) into the numbers Phase 4's dashboard and reports need. Neither function here introduces any new Prisma model — no migration is needed in this phase.

**Tech Stack:** none new — this phase is pure TypeScript logic on top of Phase 2's FX infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md` (§5.2, §5.3, §5.4)

**Depends on:** Phase 2 (`getLatestRate`, `getUsableCurrentRate`, the `ExchangeRate` cache, and every Transaction row already carrying a real `vndPerUsdAtEntry`).

## Global Constraints

- `historicalAmountIn()` is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- Package manager: npm. No `src/` directory. Import alias `@/*`. Node 20+ LTS.

---

## Task 1: `historicalAmountIn` (TDD)

**Files:**
- Create: `lib/currency/historical-amount.ts`
- Test: `lib/currency/historical-amount.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no I/O)
- Produces: `historicalAmountIn(target, tx): Decimal` — Phase 4 (Reports, dashboard KPIs) and Phase 5 (Budget progress) consume this exclusively for any historical/activity aggregation

- [ ] **Step 1: Write the failing tests**

`lib/currency/historical-amount.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { historicalAmountIn } from './historical-amount'

describe('historicalAmountIn', () => {
  it('passes through unchanged when currencies match', () => {
    const tx = { amount: new Decimal(100000), currency: 'VND' as const, vndPerUsdAtEntry: new Decimal(25000) }
    expect(historicalAmountIn('VND', tx).toNumber()).toBe(100000)
  })

  it('converts USD to VND by multiplying by the entry-time rate', () => {
    const tx = { amount: new Decimal(100), currency: 'USD' as const, vndPerUsdAtEntry: new Decimal(25000) }
    expect(historicalAmountIn('VND', tx).toNumber()).toBe(2_500_000)
  })

  it('converts VND to USD by dividing by the entry-time rate', () => {
    const tx = { amount: new Decimal(2_500_000), currency: 'VND' as const, vndPerUsdAtEntry: new Decimal(25000) }
    expect(historicalAmountIn('USD', tx).toNumber()).toBe(100)
  })

  it('is stable regardless of what "today\'s" rate might be — it never consults live state', () => {
    const januaryTx = { amount: new Decimal(2_500_000), currency: 'VND' as const, vndPerUsdAtEntry: new Decimal(25000) }
    const resultBefore = historicalAmountIn('USD', januaryTx)
    const resultAfter = historicalAmountIn('USD', januaryTx)
    expect(resultBefore.toNumber()).toBe(100)
    expect(resultAfter.toNumber()).toBe(100)
  })
})
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run lib/currency/historical-amount.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/currency/historical-amount.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import type { Currency } from './provider'

export interface HistoricalAmountInput {
  amount: Decimal
  currency: Currency
  vndPerUsdAtEntry: Decimal
}

export function historicalAmountIn(target: Currency, tx: HistoricalAmountInput): Decimal {
  if (tx.currency === target) return tx.amount
  if (tx.currency === 'USD' && target === 'VND') return tx.amount.mul(tx.vndPerUsdAtEntry)
  if (tx.currency === 'VND' && target === 'USD') return tx.amount.div(tx.vndPerUsdAtEntry)
  throw new Error(`Unsupported currency pair: ${tx.currency} -> ${target}`)
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/currency/historical-amount.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/currency/historical-amount.ts lib/currency/historical-amount.test.ts
git commit -m "feat: add historicalAmountIn for FX-stable historical aggregation"
```

---

## Task 2: `applyVndPerUsdRate` + `convertToCurrentAmount` (TDD)

**Files:**
- Create: `lib/currency/apply-rate.ts`, `lib/currency/current-amount.ts`
- Test: `lib/currency/current-amount.test.ts`

**Interfaces:**
- Consumes: `getUsableCurrentRate` (Phase 2 Task 8 — the shared current-rate policy: today's cache → live provider → ≤48h last-known-good → `FxUnavailableError`)
- Produces: `applyVndPerUsdRate(amount, from, to, vndPerUsd): Decimal` (pure arithmetic, reused by Phase 4's Account Balance Over Time for its historical-rate conversions), `convertToCurrentAmount(amount, fromCurrency, toCurrency, providerOverride?): Promise<Decimal>` — every current-position conversion (Total Balance, current Net Worth, Account Distribution, Debt/Loan overview) goes through this, and therefore through the same graceful fallback policy as Transaction snapshotting. It throws `FxUnavailableError` only when no usable current rate exists at all; callers rendering UI catch that and degrade (show "—" / "FX unavailable") rather than crash.

- [ ] **Step 1: Write the failing tests**

`lib/currency/current-amount.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { convertToCurrentAmount } from './current-amount'
import type { ExchangeRateProvider } from './provider'

const fakeProvider: ExchangeRateProvider = {
  getLatestRate: async () => ({ rate: 25000, effectiveDate: new Date(), fetchedAt: new Date(), source: 'fake' }),
  getHistoricalRate: async () => null,
}

afterEach(() => prisma.exchangeRate.deleteMany({ where: { source: 'fake' } }))

describe('convertToCurrentAmount', () => {
  it('returns the same amount when currencies match, without calling the provider', async () => {
    let called = false
    const spyProvider: ExchangeRateProvider = {
      getLatestRate: async () => { called = true; throw new Error('should not be called') },
      getHistoricalRate: async () => null,
    }
    const result = await convertToCurrentAmount(100000, 'VND', 'VND', spyProvider)
    expect(result.toNumber()).toBe(100000)
    expect(called).toBe(false)
  })

  it('converts using the current rate when currencies differ', async () => {
    const result = await convertToCurrentAmount(100, 'USD', 'VND', fakeProvider)
    expect(result.toNumber()).toBe(2_500_000)
  })

  it('degrades gracefully to a recent last-known-good rate when the provider is down', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await prisma.exchangeRate.create({
      data: { base: 'USD', quote: 'VND', rate: 24000, effectiveDate: twoHoursAgo, fetchedAt: twoHoursAgo, source: 'fake' },
    })
    const failingProvider: ExchangeRateProvider = {
      getLatestRate: async () => { throw new Error('provider down') },
      getHistoricalRate: async () => null,
    }
    const result = await convertToCurrentAmount(100, 'USD', 'VND', failingProvider)
    expect(result.toNumber()).toBe(2_400_000)
  })

  it('throws FxUnavailableError when the provider is down and no recent rate exists', async () => {
    const failingProvider: ExchangeRateProvider = {
      getLatestRate: async () => { throw new Error('provider down') },
      getHistoricalRate: async () => null,
    }
    await expect(convertToCurrentAmount(100, 'USD', 'VND', failingProvider)).rejects.toThrow(FxUnavailableError)
  })
})
```
Add `import { FxUnavailableError } from './current-rate-policy'` to the test's imports.

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run lib/currency/current-amount.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`lib/currency/apply-rate.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import type { Currency } from './provider'

export function applyVndPerUsdRate(amount: Decimal, from: Currency, to: Currency, vndPerUsd: Decimal): Decimal {
  if (from === to) return amount
  if (from === 'USD' && to === 'VND') return amount.mul(vndPerUsd)
  if (from === 'VND' && to === 'USD') return amount.div(vndPerUsd)
  throw new Error(`Unsupported currency pair: ${from} -> ${to}`)
}
```

`lib/currency/current-amount.ts`:
```ts
import { Decimal } from '@prisma/client/runtime/library'
import { getUsableCurrentRate } from './current-rate-policy'
import { applyVndPerUsdRate } from './apply-rate'
import type { Currency, ExchangeRateProvider } from './provider'

/**
 * Current-position conversion. Uses the shared getUsableCurrentRate policy, so a temporary
 * provider outage degrades to a recent last-known-good rate exactly as Transaction snapshotting
 * does, and only fails (FxUnavailableError) when nothing acceptably fresh exists. Never used
 * for historical activity (that's historicalAmountIn) or historical position points (that's
 * getHistoricalRate).
 */
export async function convertToCurrentAmount(
  amount: Decimal | number,
  fromCurrency: Currency,
  toCurrency: Currency,
  providerOverride?: ExchangeRateProvider,
): Promise<Decimal> {
  const amt = amount instanceof Decimal ? amount : new Decimal(amount)
  if (fromCurrency === toCurrency) return amt

  const { rate } = await getUsableCurrentRate({ base: 'USD', quote: 'VND' }, providerOverride)
  return applyVndPerUsdRate(amt, fromCurrency, toCurrency, new Decimal(rate))
}
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run lib/currency/current-amount.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add lib/currency/apply-rate.ts lib/currency/current-amount.ts lib/currency/current-amount.test.ts
git commit -m "feat: add applyVndPerUsdRate and convertToCurrentAmount for live position aggregation"
```

---

## Phase 3 Acceptance Check

- [ ] `historicalAmountIn` has zero dependency on live state or `User.baseCurrency` — verified by its test suite taking no such input at all.
- [ ] `convertToCurrentAmount` never calls the provider when source and target currencies already match.
- [ ] `npm run test`, `npm run lint`, and `npm run build` all succeed.

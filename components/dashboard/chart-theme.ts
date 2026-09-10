/**
 * The one place chart styling is decided, so five widgets cannot each invent
 * their own idea of what "income" looks like.
 *
 * Every colour is a `var(--color-*)` reference, never a literal and never an
 * `hsl(var(--x))` wrapper: the tokens in `app/globals.css` are already complete
 * `oklch()` colours, so they are used as-is and follow the light/dark switch
 * for free. A hard-coded hex here would be the one element on the page that
 * ignores the user's theme.
 *
 * ## The semantic colour convention (Task 14, owner item E3)
 *
 * Four slots, and every mark in the product belongs to exactly one of them:
 *
 * | slot | token | when |
 * |---|---|---|
 * | income | `--color-positive` (jade) | a series that stands OPPOSITE an expense series |
 * | expense | `--color-negative` (muted salmon, never neon) | a series that stands OPPOSITE an income series |
 * | net / headline | `--color-brand` | the one summarising series in its plot |
 * | share / distribution | `--color-accent` (muted blue) | a breakdown of one quantity into parts |
 *
 * The distinction that decides the ambiguous cases is **opposition, not
 * subject matter**: `income`/`expense` are for the two halves of a
 * good/bad comparison, where the pairing is the information. A chart whose
 * whole content is one quantity split into parts is a `distribution` even
 * when that quantity is spending — the sign is already stated by the card's
 * title and by every figure beside the bars, so colouring the parts
 * "negative" adds no fact and only makes the card shout. That is why
 * `components/reports/category-bars.tsx` passes `tone="accent"` and why
 * `components/dashboard/expense-by-category-chart.tsx` uses `distribution`:
 * the two are the same breakdown of the same numbers in two places, and they
 * must not disagree. `account-distribution-chart.tsx` is the same slot.
 *
 * `net` and `balance` are both "the headline", but they are separate keys on
 * purpose: `net` shares a plot with income and expense (cash-flow trend),
 * `balance` is alone in its plot (balance history). If a future trend chart
 * makes the net line hard to tell from the jade income line, the escape hatch
 * is to point `net` at `--color-foreground` — a neutral total among two
 * judged series — and NOT to invent a sixth hue.
 *
 * ## What dark mode may and may not change here
 *
 * Nothing in this file is theme-aware, and that is the design: a chart colour
 * that fails its 3:1 against `--surface` in dark is fixed by nudging the token
 * in the `.dark` block of `app/globals.css`, never by branching here. Measured
 * in dark at the Task 14 pass, every series clears it with margin —
 * brand 5.13:1, accent 4.91:1, positive 4.66:1, negative 5.13:1,
 * warning 6.49:1 — and the dark salmon reads muted rather than neon, so no
 * `--chart-expense` token was needed.
 */
export const CHART_COLORS = {
  /** Only opposite an expense series. A lone income breakdown is `distribution`. */
  income: 'var(--color-positive)',
  /** Only opposite an income series. A lone expense breakdown is `distribution`. */
  expense: 'var(--color-negative)',
  /** Net income: the summarising series where income and expense are also plotted. */
  net: 'var(--color-brand)',
  /** The balance line, which is the only series in its plot. */
  balance: 'var(--color-brand)',
  /** A breakdown of one quantity into parts — a neutral fact, not a judgement. */
  distribution: 'var(--color-accent)',
  grid: 'var(--color-border)',
  axis: 'var(--color-muted-foreground)',
} as const

/**
 * Chart body heights, per the spec's grid (§6.1). Three values, not one: row 3
 * is 300 px, row 4 is 260, row 5 is ≤ 240, and the mobile trend is 220. A
 * single shared height is what left a two-column row landing ragged.
 */
export const CHART_HEIGHT = { tall: 300, medium: 260, short: 240, mobileTrend: 220 } as const

/**
 * Axis chrome: present enough to read against, quiet enough to ignore.
 *
 * `tabular-nums` matters more on an axis than anywhere else — proportional
 * digits give each tick a different width, so a column of numbers stops lining
 * up under itself and the scale becomes harder to read than the data.
 */
export const AXIS_PROPS = {
  tick: { fill: CHART_COLORS.axis, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  tickLine: false,
  axisLine: false,
} as const

/** Thin strokes, no dots, no animation — a calm line, not a moving one. */
export const LINE_PROPS = {
  type: 'monotone',
  strokeWidth: 1.5,
  dot: false,
  activeDot: { r: 3 },
  isAnimationActive: false,
} as const

export const BAR_PROPS = {
  isAnimationActive: false,
  radius: 2,
} as const

export const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  fontSize: '0.75rem',
  color: 'var(--color-foreground)',
  boxShadow: '0 8px 24px rgba(25, 33, 30, 0.10)',
} as const

export const TOOLTIP_LABEL_STYLE = { color: 'var(--color-muted-foreground)' } as const

/** The hover band behind bars. `--color-muted` is the same wash the rail's active row uses. */
export const BAR_CURSOR = { fill: 'var(--color-muted)' } as const

export const LINE_CURSOR = { stroke: 'var(--color-border)' } as const

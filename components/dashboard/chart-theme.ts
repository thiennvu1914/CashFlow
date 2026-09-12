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
 * | net / headline | `--color-foreground` on a chart that also plots income; `--color-brand` when it is the only headline series (balance) | the one summarising series in its plot |
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
 * `net` and `balance` are both "the headline", and they hold DIFFERENT tokens
 * for a measured reason. `balance` is the only series in its plot (balance
 * history), so the brand colour marks it as the headline with nothing to
 * confuse it with. `net` shares its plot with income and expense (the
 * cash-flow trend), and `--color-brand` collided with `--color-positive`
 * there: the two greens are 0.035 apart in OKLab deltaE in dark and 0.047 in
 * light, against roughly 0.10 as the point where a 1.5 px line reads as a
 * different colour at a glance — 4-6x closer than any other pair on the same
 * plot, and visibly one line in the screenshots, in the legend swatches and in
 * the tooltip's coloured series names alike. `net` is therefore
 * `--color-foreground`: a NEUTRAL total among two judged series, which is what
 * a net figure is, and which separates cleanly from both (income 0.351 dark /
 * 0.298 light, expense 0.305 / 0.350). Inventing a sixth hue was the
 * alternative and is not allowed — the palette has four semantic slots and
 * that is the point of this file.
 *
 * ## What dark mode may and may not change here
 *
 * Nothing in this file is theme-aware, and that is the design: a chart colour
 * that fails a measurement in dark is fixed by nudging the token in the
 * `.dark` block of `app/globals.css`, never by branching here.
 *
 * There are two measurements, and they need different maths:
 *
 * 1. **Series against its surface** — WCAG contrast, minimum 3:1 (1.4.11).
 *    Measured in dark at the Task 14 pass, every series clears it with margin:
 *    brand 5.13:1, accent 4.91:1, positive 4.66:1, negative 5.13:1,
 *    warning 6.49:1, foreground 14.07:1. The dark salmon reads muted rather
 *    than neon, so no `--chart-expense` token was needed.
 * 2. **Series against series** — "can I tell these two lines apart", for which
 *    a WCAG ratio is the WRONG tool: it is a luminance ratio, so two hues of
 *    equal lightness score 1.05:1 and are still obviously different. Use
 *    OKLab deltaE instead, and treat ~0.10 as the floor for a 1.5 px line. On
 *    the trend chart after this pass: income/expense 0.197 dark and 0.217
 *    light, income/net 0.351 and 0.298, expense/net 0.305 and 0.350. The
 *    number that failed it — income/net at 0.035 and 0.047 while `net` was
 *    `--color-brand` — is why `net` now holds `--color-foreground`.
 *
 * Both measurements are recorded, with the method, in the MEASURED WCAG
 * CONTRAST block in `app/globals.css`.
 */
export const CHART_COLORS = {
  /** Only opposite an expense series. A lone income breakdown is `distribution`. */
  income: 'var(--color-positive)',
  /** Only opposite an income series. A lone expense breakdown is `distribution`. */
  expense: 'var(--color-negative)',
  /**
   * Net income: the summarising series on a plot that ALSO carries income and
   * expense, so it is the neutral total among two judged series. Not
   * `--color-brand`, which is 0.035 OKLab deltaE from `--color-positive` in
   * dark (0.047 in light) and read as the same green — see the doc above.
   */
  net: 'var(--color-foreground)',
  /** The balance line, which is the only series in its plot — so brand marks the headline. */
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
  strokeWidth: 2.2,
  dot: false,
  activeDot: { r: 5, strokeWidth: 2, stroke: 'var(--color-surface)' },
  isAnimationActive: false,
} as const

export const BAR_PROPS = {
  isAnimationActive: false,
  radius: 4,
} as const

export const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: '12px',
  fontSize: '0.8125rem',
  color: 'var(--color-foreground)',
  boxShadow: '0 12px 30px -4px rgba(0, 0, 0, 0.2), 0 4px 12px -2px rgba(0, 0, 0, 0.1)',
  padding: '10px 14px',
} as const

export const TOOLTIP_LABEL_STYLE = { color: 'var(--color-muted-foreground)' } as const

/** The hover band behind bars. `--color-muted` is the same wash the rail's active row uses. */
export const BAR_CURSOR = { fill: 'var(--color-muted)' } as const

export const LINE_CURSOR = { stroke: 'var(--color-border)' } as const

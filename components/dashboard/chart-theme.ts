/**
 * The one place chart styling is decided, so five widgets cannot each invent
 * their own idea of what "income" looks like.
 *
 * Every colour is a `var(--color-*)` reference, never a literal and never an
 * `hsl(var(--x))` wrapper: the tokens in `app/globals.css` are already complete
 * `oklch()` colours, so they are used as-is and follow the light/dark switch
 * for free. A hard-coded hex here would be the one element on the page that
 * ignores the user's theme.
 */
export const CHART_COLORS = {
  income: 'var(--color-positive)',
  expense: 'var(--color-negative)',
  /** Net income, and the balance line — the brand colour marks "the headline series". */
  net: 'var(--color-brand)',
  balance: 'var(--color-brand)',
  /** Distribution is a neutral breakdown, not a good/bad judgement. */
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

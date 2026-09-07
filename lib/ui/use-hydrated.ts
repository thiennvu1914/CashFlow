import { useSyncExternalStore } from 'react'

/**
 * `false` on the server and throughout hydration, `true` from the moment React
 * owns the DOM (and immediately, on a client-side mount).
 *
 * ---------------------------------------------------------------------------
 * Why this exists: the silent-reversion defect it fixes
 * ---------------------------------------------------------------------------
 * Every SSR'd money form in this app registers uncontrolled controls with
 * `react-hook-form`'s `register()`. Between first paint and the end of
 * hydration those controls are real, focusable DOM — and anything the user
 * does to them in that window used to be thrown away without a trace. A
 * Transaction Type deliberately changed to INCOME came back as EXPENSE a
 * moment later, with the Category list still showing EXPENSE categories: a
 * user's income silently recorded as an expense.
 *
 * Three independently verified facts combine to produce it. Line numbers are
 * the versions installed here (react-hook-form 7.87, react-dom 19.2.8):
 *
 * 1. `register()` returns only `{ name, onChange, onBlur, ref }` (plus
 *    `disabled`/progressive attributes) — no `value`, no `defaultValue`:
 *    `node_modules/react-hook-form/dist/index.esm.mjs:3118-3183`. So the
 *    server HTML carries no default at all, and a `<select>` renders its
 *    FIRST option. On `/transactions` the first option is Income while
 *    `useForm`'s default — and therefore the server-rendered Category list —
 *    is EXPENSE. That mismatch is on screen before the user touches anything.
 *
 * 2. React deliberately does not rewrite a form control's value while
 *    hydrating, so whatever the user changed pre-hydration is still in the DOM
 *    when React commits:
 *    `node_modules/react-dom/cjs/react-dom-client.development.js:5301-5305`
 *    (`prepareToHydrateHostInstance`, `case "select"`: it only validates props
 *    and subscribes to `invalid` — there is no value write at all) and
 *    `:5283-5296` + `:1720` (`case "input"` calls `initInput(..., isHydrating
 *    = true)`, and `initInput` guards the write with
 *    `isHydrating || value === element.value || (element.value = value)`).
 *
 * 3. `react-hook-form`'s `ref` callback then runs and overwrites the DOM with
 *    the JavaScript default:
 *    `index.esm.mjs:3135-3172` (the `ref:` callback ends in
 *    `updateValidAndValue(name, false, undefined, fieldRef)`) →
 *    `index.esm.mjs:2332-2344`, where
 *    `defaultValue = get(_formValues, name, get(_defaultValues, name))` is
 *    defined and so `setFieldValue(name, defaultValue)` runs →
 *    `index.esm.mjs:2621`, `fieldReference.ref.value = fieldValue`. React
 *    never saw a `change` event (no handler was attached when the user acted),
 *    so `_formValues` never learned about the user's choice and every
 *    `useWatch`-derived list stayed on the default too.
 *
 *    The same lines explain why the auth forms never showed this: when a field
 *    has NO default, `isUndefined(defaultValue)` is true at `:2340` and RHF
 *    takes the other branch — it reads the DOM into form state instead of
 *    writing over it. A live probe matched that exactly: `/accounts`' Account
 *    name (no default) kept the typed value 5/5, while Initial balance
 *    (default `0`) was reverted 5/5.
 *
 * ---------------------------------------------------------------------------
 * Why `useSyncExternalStore`, and why the timing is safe
 * ---------------------------------------------------------------------------
 * The obvious `useState(false)` + `useEffect(() => setHydrated(true))` is not
 * available: `react-hooks/set-state-in-effect` is enforced in this repo. More
 * importantly, `useSyncExternalStore` is the hook that is *specified* to
 * distinguish the server render from the client one, so the intent is legible
 * rather than a lint-dodging trick.
 *
 * The ordering guarantee that makes the gate correct is React's, not ours.
 * `mountSyncExternalStore` returns `getServerSnapshot()` while hydrating
 * (`react-dom-client.development.js:8109-8117`) and queues a **passive**
 * effect, `updateStoreInstance` (`:8148-8159`), which re-reads the client
 * snapshot and, on a difference, calls `forceStoreRerender` at the sync lane
 * (`:8238-8241`, `:8260-8262`). Passive effects run *after* the commit's
 * layout phase, and refs — including react-hook-form's — are attached during
 * that layout phase. So the re-render that enables the controls can never land
 * before RHF's `ref` callback has done its one destructive write. By the time
 * anything is interactive, the DOM and `_formValues` already agree, and every
 * later change goes through React's `change` handler like any other.
 *
 * No `'use client'` directive here on purpose: this module is only ever
 * imported by components that already declare one, and per Next 16's
 * `use-client.md` the directive marks a server/client *boundary*, not every
 * file that happens to contain client code (no other `lib/` module carries it
 * either).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * A store that never emits: hydration is a one-way transition React already
 * re-renders for, so there is nothing to subscribe to. The three callbacks are
 * module-level constants rather than inline arrows so their identities are
 * stable across renders — `subscribe`'s identity is an effect dependency
 * (`react-dom-client.development.js:8143-8146`), and a fresh function every
 * render would re-subscribe on every render.
 */
const subscribe = () => () => {}
const getSnapshot = () => true
const getServerSnapshot = () => false

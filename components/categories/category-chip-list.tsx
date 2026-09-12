'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Tags } from 'lucide-react'
import { cn } from 'cn'
import { useActionSubmit } from '@/lib/ui/use-action-submit'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { FormField } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { RowActionsMenu } from '@/components/common/row-actions-menu'
import { SectionHeader } from '@/components/common/section-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Item = { id: string; name: string; isDefault: boolean }

/**
 * One Categories section (spec §6.4): a `SectionHeader`, a wrapping row of
 * chips — default items quiet and menu-less (a default cannot be archived,
 * so offering the menu item would be a promise the server action breaks),
 * custom items with a `…` menu — and a compact inline add row beneath.
 *
 * Replaces `NamedListManager`'s bordered `<li>` list, which put a three-item
 * "Account Types" list and a twenty-item "Expense Categories" list in visually
 * identical rows and gave neither a sense of how many there were at a glance.
 */
export function CategoryChipList({
  title,
  items,
  addLabel,
  addPlaceholder,
  archiveLabel,
  onCreate,
  onArchive,
}: {
  title: string
  items: Item[]
  addLabel: string
  addPlaceholder: string
  archiveLabel: string
  onCreate: (name: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
}) {
  const t = useTranslations()
  const sectionId = useId()
  // The add input stays CONTROLLED, deliberately, and needs no `useHydrated`
  // gate: it has no `defaultValues` entry, so per `lib/ui/use-hydrated.ts`'s
  // documented branch, react-hook-form-style reversion cannot happen to a
  // field with no default in the first place — there is nothing here for the
  // gate to protect against. Do not "fix" this by adding one.
  const [name, setName] = useState('')
  const submit = useActionSubmit(t)
  /**
   * Archiving gets its OWN lock rather than sharing `submit`'s: the add row's
   * `disabled` and its "Adding…" label both read `submit.locked`/`.pending`,
   * so one shared lock would put the add button into its pending state while
   * an unrelated chip was being archived.
   */
  const archiveSubmit = useActionSubmit(t)
  const [error, setError] = useState<string | null>(null)
  /** The item awaiting archive confirmation, or `null`. One dialog per section. */
  const [pendingArchive, setPendingArchive] = useState<Item | null>(null)

  async function handleAdd() {
    if (!name.trim()) return
    await submit.run({
      tag: 'CategoryChipList: create failed',
      // No `errorKeys`: the page's inline server actions (`app/(app)/categories/
      // page.tsx`) return `Promise<void>`, so a REFUSED create is invisible
      // here and only a throw reaches this component. Unchanged from before —
      // widening that contract would be a product change, not a refactor.
      action: () => onCreate(name.trim()),
      onError: (failure) => setError(failure?.message ?? null),
      onSuccess: () => setName(''),
    })
  }

  async function confirmArchive(item: Item) {
    await archiveSubmit.run({
      tag: 'CategoryChipList: archive failed',
      action: () => onArchive(item.id),
      onError: (failure) => setError(failure?.message ?? null),
      // The dialog closes on BOTH outcomes (spec §10, and the same reasoning
      // `components/accounts/account-list.tsx` spells out): left open, its
      // scrim covers the very `InlineAlert` below that explains why the
      // archive was refused, so the user would see a dialog that appears to
      // have done nothing.
      onSettled: () => setPendingArchive(null),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title={title} />

      {items.length === 0 ? (
        // The `EmptyState` primitive, not the plain muted `<p>` this used to be
        // (Task 17, owner item H2): every other empty list in the product says
        // what is missing through the same component, and a lone grey sentence
        // here was the one place that did not. No action prop — `Tags` is the
        // Categories icon from the nav, the section's own add field is the next
        // step and it is two rows below, and a button that scrolled to it would
        // be a second primary for one input.
        <EmptyState
          icon={Tags}
          title={t('categories.emptyTitle')}
          description={t('categories.emptyBody')}
        />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                // One chip height for both variants (Task 18, owner item I5).
                // A custom chip's `…` trigger is 44 px below `md` and 36 px
                // from `md` (`RowActionsMenu`, spec §8's touch target), so a
                // custom chip stood 46/38 px tall while a default chip stood
                // 28 — and because the `<ul>` is `flex-wrap` (default
                // `align-items: stretch`), any default chip that happened to
                // land in the same wrap row was stretched to match while the
                // rows above it stayed short. Three different heights on one
                // page. `min-h-11 md:min-h-9` is the same floor every other
                // interactive row in the product uses, and the default
                // variant carries a transparent border so both variants
                // measure the same box. No action is hidden: the `…` is
                // exactly where it was.
                'inline-flex min-h-11 items-center gap-1 rounded-full pl-3 text-sm transition-all duration-150 md:min-h-9',
                item.isDefault
                  ? 'border border-transparent bg-muted pr-3 text-muted-foreground'
                  : 'border border-border pr-1 text-foreground shadow-2xs hover:border-brand/40 hover:shadow-xs',
              )}
            >
              <span>{item.name}</span>
              {!item.isDefault && (
                <RowActionsMenu
                  label={t('common.rowActions', { name: item.name })}
                  actions={[
                    {
                      id: 'archive',
                      label: archiveLabel,
                      tone: 'negative',
                      // Clears a previous attempt's message first, so a
                      // retry starts clean (same as `AccountList`).
                      onSelect: () => {
                        setError(null)
                        setPendingArchive(item)
                      },
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        {/* Capped, not stretched (Task 18, owner item I5): `flex-1` alone gave
            a one-word category name an 800 px input on a 960 px page, three
            times over, which is what made this page read as three stretched
            rows rather than three compact sections. The cap is `sm:` only, so
            a phone keeps the full-width field it needs. */}
        <FormField id={`${sectionId}-new`} label={addLabel} className="flex-1 sm:max-w-[22rem]">
          {(aria) => (
            <Input
              {...aria}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={addPlaceholder}
              disabled={submit.locked}
            />
          )}
        </FormField>
        <Button type="button" onClick={handleAdd} disabled={submit.locked || name.trim() === ''}>
          {submit.pending ? t('categories.addPending') : t('categories.addAction')}
        </Button>
      </div>

      {error && <InlineAlert tone="negative">{error}</InlineAlert>}

      <ConfirmDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => !open && setPendingArchive(null)}
        title={
          pendingArchive ? t('categories.archiveConfirmTitle', { name: pendingArchive.name }) : ''
        }
        description={t('categories.archiveConfirmBody')}
        confirmLabel={archiveLabel}
        cancelLabel={t('common.cancel')}
        pendingLabel={t('categories.archivePending')}
        onConfirm={() => (pendingArchive ? confirmArchive(pendingArchive) : undefined)}
      />
    </div>
  )
}

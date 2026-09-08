'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
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
  const submit = useSubmitState()
  const [error, setError] = useState<string | null>(null)
  /** The item awaiting archive confirmation, or `null`. One dialog per section. */
  const [pendingArchive, setPendingArchive] = useState<Item | null>(null)

  async function handleAdd() {
    if (!name.trim()) return
    setError(null)
    await submit.run(async () => {
      try {
        await onCreate(name.trim())
        setName('')
      } catch {
        console.error('CategoryChipList: create failed')
        setError(t(GENERIC_ERROR_KEY))
      }
    })
  }

  async function confirmArchive(item: Item) {
    setError(null)
    try {
      await onArchive(item.id)
      setPendingArchive(null)
    } catch {
      console.error('CategoryChipList: archive failed')
      setError(t(GENERIC_ERROR_KEY))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title={title} />

      {items.length === 0 ? (
        <p className="text-[0.8125rem]/[1.125rem] text-muted-foreground">
          {t('categories.emptyTitle')}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                'inline-flex items-center gap-1 rounded-full py-1 pl-3 text-sm',
                item.isDefault
                  ? 'bg-muted pr-3 text-muted-foreground'
                  : 'border border-border pr-1 text-foreground',
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
                      onSelect: () => setPendingArchive(item),
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <FormField id={`${sectionId}-new`} label={addLabel} className="flex-1">
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

'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Item = { id: string; name: string; isDefault: boolean }

const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function NamedListManager({
  title,
  items,
  onCreate,
  onArchive,
}: {
  title: string
  items: Item[]
  onCreate: (name: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd() {
    if (!name.trim()) return
    setPending(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setName('')
    } catch {
      console.error('NamedListManager: create failed')
      setError(GENERIC_ERROR)
    } finally {
      setPending(false)
    }
  }

  async function handleArchive(id: string) {
    setError(null)
    try {
      await onArchive(id)
    } catch {
      console.error('NamedListManager: archive failed')
      setError(GENERIC_ERROR)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between rounded-md border p-2">
            <span>{item.name}</span>
            {!item.isDefault && (
              <Button variant="outline" size="sm" onClick={() => handleArchive(item.id)}>
                Archive
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New name"
          aria-label={`${title}: new name`}
        />
        <Button onClick={handleAdd} disabled={pending}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </div>
  )
}

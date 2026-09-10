import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import viValidation from '@/messages/vi/validation.json'
import enValidation from '@/messages/en/validation.json'
import { ZOD_MESSAGE_PATTERN, validationMessageKey } from './validation-messages'

/**
 * Every Zod message literal in `lib/validation/**` has a Vietnamese and an
 * English entry (spec §4).
 *
 * It reads the SOURCE rather than importing the schemas, for two reasons: a
 * schema's message is only reachable at runtime by making it fail, which would
 * mean constructing an invalid input per rule; and the Prisma client these
 * modules pull in is WASM-based and needs a driver adapter, which a pure unit
 * test should not require.
 *
 * A literal the regex cannot see is the one way this can pass while the UI
 * still shows English — so when a message is added in a shape the pattern
 * misses, the fix is the PATTERN, and this comment is the reminder.
 */
function validationSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return validationSourceFiles(full)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [full]
  })
}

function literals(): string[] {
  const found = new Set<string>()
  for (const file of validationSourceFiles(path.join(process.cwd(), 'lib', 'validation'))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(ZOD_MESSAGE_PATTERN)) {
      const literal = match.groups?.message
      if (literal) found.add(literal)
    }
  }
  return [...found].sort()
}

function at(tree: unknown, key: string): unknown {
  return key
    .replace(/^validation\./, '')
    .split('\u0000')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree)
}

describe('validation message dictionary', () => {
  it('finds the schemas’ literals at all — a zero-hit regex would pass vacuously', () => {
    const all = literals()
    expect(all.length).toBeGreaterThan(15)
    // Three the schemas definitely carry today, as canaries.
    expect(all).toContain('Enter an amount')
    expect(all).toContain('Name is required')
    expect(all).toContain('Timezone is required')
  })

  it('has a vi and an en entry for every literal', () => {
    const missingVi: string[] = []
    const missingEn: string[] = []
    for (const literal of literals()) {
      const key = validationMessageKey(literal)
      if (typeof at(viValidation, key) !== 'string') missingVi.push(literal)
      if (typeof at(enValidation, key) !== 'string') missingEn.push(literal)
    }
    expect({ missingVi, missingEn }).toEqual({ missingVi: [], missingEn: [] })
  })

  it('has no entry that no schema emits — dead copy rots', () => {
    // Compared as ESCAPED keys, not raw literals: `validation.json` is keyed
    // by `validationMessageKey`'s output (dots become the DOT-leader
    // character `at` also expects), and one real literal in this codebase —
    // "Enter a valid IANA timezone, e.g. Asia/Ho_Chi_Minh" — contains two
    // dots. Comparing raw literals against escaped keys would flag that
    // entry as stale even though it is exactly what the schema emits.
    const live = new Set(
      literals().map((literal) => validationMessageKey(literal).replace(/^validation\./, '')),
    )
    const stale = Object.keys(viValidation as Record<string, string>).filter(
      (key) => !live.has(key),
    )
    expect(stale).toEqual([])
  })

  it('keys a literal containing a dot without splitting it', () => {
    // next-intl treats `.` as a path separator, so a message like "Total must
    // equal principal plus interest." cannot be a bare key.
    const key = validationMessageKey('Total must equal principal plus interest.')
    expect(key.startsWith('validation.')).toBe(true)
    expect(key.slice('validation.'.length)).not.toContain('.')
  })
})

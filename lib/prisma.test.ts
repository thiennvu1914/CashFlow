import { describe, expect, it } from 'vitest'
import { PRISMA_POOL_OPTIONS } from '@/lib/prisma'

describe('PRISMA_POOL_OPTIONS', () => {
  // The pool is tuned for one long-lived Node process talking to Supabase's
  // session-mode pooler across the Singapore→Sydney link: keep idle sockets
  // alive for minutes so a click after a pause reuses them instead of paying
  // a fresh TCP+TLS+auth handshake, and fail fast when the database is
  // unreachable instead of hanging the request.
  it('keeps pooled connections warm and bounds connect time', () => {
    expect(PRISMA_POOL_OPTIONS).toEqual({
      max: 6,
      idleTimeoutMillis: 300_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
    })
  })
})

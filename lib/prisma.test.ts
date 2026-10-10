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
      keepAliveInitialDelayMillis: 30_000,
    })
  })

  // pg hands `keepAliveInitialDelayMillis` straight to `socket.setKeepAlive`,
  // where 0 (its default) means the OS default — two hours on Linux. The first
  // probe has to go out well inside the 300 s idle window, or `keepAlive` keeps
  // nothing alive.
  it('sends the first keepalive probe well inside the idle window', () => {
    expect(PRISMA_POOL_OPTIONS.keepAliveInitialDelayMillis).toBeGreaterThan(0)
    expect(PRISMA_POOL_OPTIONS.keepAliveInitialDelayMillis).toBeLessThan(
      PRISMA_POOL_OPTIONS.idleTimeoutMillis / 2,
    )
  })
})

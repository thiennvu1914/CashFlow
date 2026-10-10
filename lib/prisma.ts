import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { loadServerEnv } from '@/lib/server/env'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * pg-pool settings for one long-lived Node process talking to Supabase's
 * session-mode pooler in another region. The defaults (10 connections, closed
 * after 10 s idle, no connect timeout) made every click after a short pause
 * re-handshake TCP+TLS+auth across the Singapore→Sydney link.
 * `max` stays well under the Supavisor session pool; `connectionTimeoutMillis`
 * turns an unreachable database into a fast error instead of a hung request.
 * `keepAlive` alone sends no probe for two hours: pg passes
 * `keepAliveInitialDelayMillis` (default 0) to `socket.setKeepAlive`, where 0
 * means the OS default, 7200 s on Linux — far beyond the 300 s a pooled socket
 * may sit idle. 30 s starts the probes inside that window, where they keep a
 * quiet connection's state alive in any NAT or proxy on the way and surface a
 * dead one before a request picks it up.
 */
export const PRISMA_POOL_OPTIONS = {
  max: 6,
  idleTimeoutMillis: 300_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
} as const

function createPrismaClient() {
  // Validates the whole server environment once per process (fatal in
  // production, a warning in development), before the first request that
  // touches the database, auth or email. `DATABASE_URL` is read back from the
  // validated contract so this factory and `lib/server/env.ts` cannot disagree
  // about what counts as configured.
  const connectionString = loadServerEnv().databaseUrl
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  // The Prisma 7 client is WASM-based and throws
  // `PrismaClientInitializationError: A driver adapter is required` when
  // constructed without one. The datasource URL lives only in
  // `prisma7.config.ts`, which is CLI-only and never reaches the runtime
  // client, so it has to be supplied here.
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...PRISMA_POOL_OPTIONS }),
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

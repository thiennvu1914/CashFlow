import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { loadServerEnv } from '@/lib/server/env'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

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
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

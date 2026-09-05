import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL
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

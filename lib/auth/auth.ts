import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '@/lib/prisma'
import { createAuth } from './create-auth'

/**
 * The application's Better Auth instance. Every session check in every phase
 * imports this. Tests build their own instance with `createAuth` instead, so
 * they never need a database.
 */
export const auth = createAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
})

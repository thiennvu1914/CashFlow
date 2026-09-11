import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '@/lib/prisma'
import { sendResetPasswordEmail } from '@/lib/email/send-reset-password-email'
import { seedDefaultsForUser } from '@/lib/server/defaults'
import { loadServerEnv } from '@/lib/server/env'
import { createAuth } from './create-auth'

// Crash a production boot whose environment cannot support safe auth — a
// missing, placeholder or too-short BETTER_AUTH_SECRET, a missing
// BETTER_AUTH_URL or TRUSTED_PROXY_CIDRS — rather than serving requests with a
// forgeable session cookie, a spoofable rate-limit key or a
// host-header-derived reset link. `lib/server/env.ts` owns the whole contract
// (this replaces the former `lib/auth/production-config.ts`); outside
// production it warns and continues, so dev and test are unaffected.
const serverEnv = loadServerEnv()

/**
 * The application's Better Auth instance. Every session check in every phase
 * imports this. Tests build their own instance with `createAuth` instead, so
 * they never need a database.
 */
export const auth = createAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  sendResetPasswordEmail,
  trustedProxies: serverEnv.trustedProxyCidrs,
  // Passing the validated secret makes the value Better Auth signs with the
  // same one this app refused to start without. Left undefined when unset
  // (dev/test), which keeps Better Auth's own environment fallback.
  ...(serverEnv.betterAuthSecret === undefined ? {} : { secret: serverEnv.betterAuthSecret }),
  // Every new account starts with its own default account types and categories
  // (§4.2 of the spec), created in the same request that creates the user.
  onUserCreated: (user) => seedDefaultsForUser(user.id),
})

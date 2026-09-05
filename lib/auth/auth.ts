import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '@/lib/prisma'
import { sendResetPasswordEmail } from '@/lib/email/send-reset-password-email'
import { createAuth } from './create-auth'
import { assertProductionAuthConfig } from './production-config'
import { parseTrustedProxies } from './trusted-proxies'

// Crash a production boot that is missing BETTER_AUTH_URL or
// TRUSTED_PROXY_CIDRS rather than serving requests with a spoofable rate-limit
// key or a host-header-derived reset link. No-op outside production, so dev and
// test are unaffected when the variables are unset.
assertProductionAuthConfig(process.env)

/**
 * The application's Better Auth instance. Every session check in every phase
 * imports this. Tests build their own instance with `createAuth` instead, so
 * they never need a database.
 */
export const auth = createAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  sendResetPasswordEmail,
  trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXY_CIDRS),
})

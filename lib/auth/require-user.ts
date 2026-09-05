import { headers } from 'next/headers'
import { auth } from '@/lib/auth/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

export async function getOptionalSession() {
  return auth.api.getSession({ headers: await headers() })
}

export async function requireUser() {
  const session = await getOptionalSession()
  if (!session?.user) throw new UnauthorizedError()
  return session.user
}

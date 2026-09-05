import { redirect } from 'next/navigation'
import { getOptionalSession } from '@/lib/auth/require-user'

export default async function Home() {
  const session = await getOptionalSession()
  redirect(session?.user ? '/dashboard' : '/login')
}

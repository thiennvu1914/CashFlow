import { redirect } from 'next/navigation'
import { getOptionalSession } from '@/lib/auth/require-user'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  return <div className="min-h-screen bg-background">{children}</div>
}

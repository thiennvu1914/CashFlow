import { redirect } from 'next/navigation'
import { getOptionalSession } from '@/lib/auth/require-user'
import { AppShell } from '@/components/layout/app-shell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // UX only — the redirect that actually guards the data is in each page (see
  // the note in `app/(app)/settings/page.tsx`): a layout is not an auth
  // boundary. The session lookup is memoized per request, so asking here and
  // again in the page costs one query.
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  // The NAME only, never the session object: `AppShell` is a client component,
  // and handing it the session would ship the whole user record — email,
  // `isDemo`, preferences — into the browser bundle to render one line of text.
  return <AppShell userName={session.user.name}>{children}</AppShell>
}

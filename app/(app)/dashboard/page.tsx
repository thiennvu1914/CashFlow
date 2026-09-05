import Link from 'next/link'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardPage() {
  // See the note in `app/(app)/settings/page.tsx`: the layout redirect is UX,
  // the page is the auth boundary.
  const user = await requireUserOrRedirect()

  return (
    <div className="flex flex-col gap-4 p-4">
      <p>
        Signed in as {user.name} ({user.email})
      </p>
      <p>Dashboard placeholder — Phase 1 protected route check</p>
      <Link href="/settings" className="text-sm text-primary underline-offset-4 hover:underline">
        Settings
      </Link>
      <LogoutButton />
    </div>
  )
}

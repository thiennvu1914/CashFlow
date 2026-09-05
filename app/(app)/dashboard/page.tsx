import Link from 'next/link'
import { LogoutButton } from '@/components/auth/logout-button'

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p>Dashboard placeholder — Phase 1 protected route check</p>
      <Link href="/settings" className="text-sm text-primary underline-offset-4 hover:underline">
        Settings
      </Link>
      <LogoutButton />
    </div>
  )
}

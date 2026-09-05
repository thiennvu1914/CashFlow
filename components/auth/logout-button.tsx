'use client'

import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'

export function LogoutButton() {
  const router = useRouter()

  async function handleLogout() {
    try {
      await authClient.signOut()
    } catch {
      console.error('Sign-out request failed')
      // Fall through and navigate anyway — a failed sign-out call must not
      // strand the user on a page that requires a session.
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <Button variant="outline" onClick={handleLogout}>
      Log out
    </Button>
  )
}

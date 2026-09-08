'use client'

import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from 'cn'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'

export function LogoutButton({ compact }: { compact?: boolean }) {
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

  const t = useTranslations()

  return (
    // Ghost, and full width in the rail: it is the last thing in a column of
    // links, not a call to action (spec §5, §14 decision 4). `compact` (the
    // rail and the icon rail) centres at md and aligns with the nav items
    // above it from xl; the More sheet (not `compact`) always shows the label
    // left-aligned, because `xl:not-sr-only` never applies there — the sheet
    // only exists below `md`.
    <Button
      variant="ghost"
      size="sm"
      onClick={handleLogout}
      aria-label={t('nav.logout')}
      title={t('nav.logout')}
      className={cn(
        'w-full text-muted-foreground',
        compact ? 'justify-center xl:justify-start' : 'justify-start',
      )}
    >
      <LogOut aria-hidden="true" className="size-4" />
      <span className={compact ? 'sr-only xl:not-sr-only' : undefined}>{t('nav.logout')}</span>
    </Button>
  )
}

import { getTranslations } from 'next-intl/server'
import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { PageHeader } from '@/components/common/page-header'
import { ProfileForm } from '@/components/settings/profile-form'
import { ChangePasswordForm } from '@/components/settings/change-password-form'
import { SettingsCard } from '@/components/settings/settings-card'

export default async function SettingsPage() {
  // The `(app)` layout also redirects, but a layout is not an auth boundary:
  // Next renders layout and page concurrently, and a client-side navigation can
  // re-render this page without re-running the layout. The session lookup is
  // memoized per request (`getOptionalSession`), so asking twice costs one
  // query.
  const user = await requireUserOrRedirect()
  const defaults = resolveProfileDefaults(user)
  const t = await getTranslations()

  return (
    <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
      <PageHeader title={t('settings.title')} />

      {/* ONE form spanning the first two cards, with its Save below them
          (amended spec §6.9) — the card copy is passed in because the form owns
          the `<form>` element the two cards sit inside. */}
      <ProfileForm
        defaultValues={defaults}
        email={user.email}
        labels={{
          profileTitle: t('settings.profileTitle'),
          profileDescription: t('settings.profileDescription'),
          preferencesTitle: t('settings.preferencesTitle'),
          preferencesDescription: t('settings.preferencesDescription'),
        }}
      />

      <SettingsCard
        title={t('settings.securityTitle')}
        description={t('settings.securityDescription')}
      >
        <ChangePasswordForm />
      </SettingsCard>
    </div>
  )
}

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
    // `max-w-[42rem]` (672 px), not the `max-w-[30rem]` single-column form
    // width every create sheet uses (Task 18, owner item I1). Settings is not
    // one form in a sheet: it is three titled sections on a full page, and at
    // 480 px they read as a narrow strip floating in the middle of a 1200 px
    // content area — the one page in the product whose column looked like a
    // mistake next to the 960 px list pages beside it. 672 is inside the
    // owner's 640–720 range and keeps every section left-aligned to the same
    // edge as the header above them.
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-8 p-4 md:p-6 lg:p-8">
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

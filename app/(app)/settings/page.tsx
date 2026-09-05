import { requireUserOrRedirect } from '@/lib/auth/require-user'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { ProfileForm } from '@/components/settings/profile-form'
import { ChangePasswordForm } from '@/components/settings/change-password-form'

export default async function SettingsPage() {
  // The `(app)` layout also redirects, but a layout is not an auth boundary:
  // Next renders layout and page concurrently, and a client-side navigation can
  // re-render this page without re-running the layout. The session lookup is
  // memoized per request (`getOptionalSession`), so asking twice costs one
  // query.
  const user = await requireUserOrRedirect()

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-6">
      <section>
        <h2 className="mb-4 text-lg font-semibold">Profile</h2>
        <ProfileForm defaultValues={resolveProfileDefaults(user)} />
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Change password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  )
}

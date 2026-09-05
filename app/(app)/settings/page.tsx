import { requireUser } from '@/lib/auth/require-user'
import { resolveProfileDefaults } from '@/lib/validation/profile'
import { ProfileForm } from '@/components/settings/profile-form'
import { ChangePasswordForm } from '@/components/settings/change-password-form'

export default async function SettingsPage() {
  const user = await requireUser()

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

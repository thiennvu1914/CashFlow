import { getTranslations } from 'next-intl/server'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export default async function ForgotPasswordPage() {
  const t = await getTranslations()
  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.forgotTitle')}</h1>
      <ForgotPasswordForm />
    </>
  )
}

import { getTranslations } from 'next-intl/server'
import { LoginForm } from '@/components/auth/login-form'

export default async function LoginPage() {
  const t = await getTranslations()
  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.loginTitle')}</h1>
      <LoginForm />
    </>
  )
}

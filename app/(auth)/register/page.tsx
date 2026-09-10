import { getTranslations } from 'next-intl/server'
import { RegisterForm } from '@/components/auth/register-form'

export default async function RegisterPage() {
  const t = await getTranslations()
  return (
    <>
      <h1 className="text-2xl/[1.875rem] font-semibold">{t('auth.registerTitle')}</h1>
      <RegisterForm />
    </>
  )
}

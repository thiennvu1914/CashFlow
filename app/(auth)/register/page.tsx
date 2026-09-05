import { RegisterForm } from '@/components/auth/register-form'

export default function RegisterPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Create your CashFlow account</h1>
      <RegisterForm />
    </div>
  )
}

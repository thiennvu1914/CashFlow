import { LoginForm } from '@/components/auth/login-form'

export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Sign in to CashFlow</h1>
      <LoginForm />
    </div>
  )
}

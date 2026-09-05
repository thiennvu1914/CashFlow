# CashFlow Phase 1: Auth & Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can register, log in, log out, request and complete a password reset (with a real, observable email in dev), change their password, and edit profile preferences — all behind a protected route group that redirects unauthenticated visitors, with `User.isDemo` structurally unsettable by any client.

**Architecture:** Better Auth (email+password) with the Prisma adapter, mounted at `/api/auth/[...all]`. Auth flows (sign up/in/out) go through Better Auth's own client SDK directly from client components — the one deliberate exception to the rest of the app's Server-Action-based mutation pattern, since Better Auth already owns that request/response/cookie cycle. Everything else (profile updates, change password confirmation UI) uses our own Server Actions. `requireUser()` is the single chokepoint every later phase's services call before touching data.

**Tech Stack:** Better Auth, Prisma, nodemailer, Zod, React Hook Form, Playwright (first use, installed this phase).

**Spec:** `docs/superpowers/specs/2026-09-04-cashflow-mvp-design.md`

**Depends on:** Phase 0 (`docs/superpowers/plans/2026-09-04-cashflow-phase0-bootstrap.md`) — uses its Prisma/Postgres setup, design tokens, and `resolveLocale()`.

## Global Constraints

- No stored balance column anywhere — balance is always derived from Transaction + Transfer.
- Every financial Prisma model is scoped by `userId`; cross-user relations use tenant-scoped composite foreign keys (`@@unique([userId, id])` on the parent + composite `@relation([userId, xId], [userId, id])` on the child).
- Money fields are always Prisma `Decimal`, never `Float`.
- `Transaction.amount` is always ≥ 0; sign is determined solely by `type`.
- Every Transaction snapshots `vndPerUsdAtEntry`, `fxRateTimestamp`, `fxRateSource` regardless of its own currency.
- `historicalAmountIn()` is the only function permitted to do historical currency conversion; it must never read `User.baseCurrency` or call the live FX provider.
- `User.baseCurrency` is a display/aggregation preference only — never a stored unit of financial fact.
- `User.isDemo` must never appear in any client-facing Zod schema.
- No background jobs/cron — reminders and historical FX lookups are computed lazily on read.
- Every server action/query calls `requireUser()` and scopes every query by the resulting `userId` — a client-supplied user id is never trusted.
- Zod validates every mutation server-side, independent of client-side validation.
- Package manager: npm. No `src/` directory — `app/`, `components/`, `lib/`, `prisma/` at repo root. Import alias `@/*`. Node 20+ LTS.
- **Migration workflow**: schema changes use `npx prisma migrate dev --name <description>`, never `prisma db push` — Phase 0's `db push` was the one-time empty-schema connectivity check only, not the ongoing mechanism.

**Version-verification note:** Better Auth's exact config option names (`additionalFields` shape, `rateLimit` shape, the reset-password email hook name) are written below to the best available knowledge but must be checked against the installed version's own documentation before being treated as final — if a name differs, keep the same behavior and update the name, don't skip the behavior.

---

## Task 1: Better Auth core setup + schema generation

**Files:**
- Create: `lib/auth/auth.ts`, `app/api/auth/[...all]/route.ts`
- Modify: `prisma/schema.prisma` (Better Auth's generator appends `User`, `Session`, `Account`, `Verification` models)

**Interfaces:**
- Consumes: Prisma client from Phase 0 Task 2
- Produces: `auth` (Better Auth server instance, exported from `lib/auth/auth.ts`) — every later task in this phase and every later phase's session check imports this

- [ ] **Step 1: Install Better Auth**

```bash
npm install better-auth
```

- [ ] **Step 2: Write the Better Auth config**

`lib/auth/auth.ts`:
```ts
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from '@/lib/prisma'

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // sendResetPassword is added in Task 6, once Task 5's EmailSender abstraction exists for
    // real — not stubbed here and replaced later. Forgot Password simply isn't wired up yet
    // between now and Task 6; every other auth flow (register/login/logout/change password)
    // doesn't need it and works fully from this commit onward.
  },
  user: {
    additionalFields: {
      baseCurrency: { type: 'string', defaultValue: 'VND', input: false },
      locale: { type: 'string', defaultValue: 'vi', input: false },
      theme: { type: 'string', defaultValue: 'light', input: false },
      timezone: { type: 'string', defaultValue: 'Asia/Ho_Chi_Minh', input: false },
      isDemo: { type: 'boolean', defaultValue: false, input: false },
    },
  },
})
```
`input: false` on every additional field means none of them can be set through Better Auth's own sign-up/update-user request bodies — changes go only through our own profile-update server action (Task 7), which never accepts `isDemo` at all. This is the first of two independent layers blocking client-set `isDemo` (§4.1, §13 of the spec); Task 7 adds the second.

`lib/prisma.ts` — **Prisma 7 amendment (verified during Phase 0's final review against the installed `prisma`/`@prisma/client` 7.10.0):** the Prisma 7 client is WASM-based and throws `PrismaClientInitializationError: A driver adapter is required` when constructed without one; the datasource URL lives only in `prisma7.config.ts`, which is CLI-only and never reaches the runtime client. So this file MUST pass a driver adapter. Install first:
```bash
npm install @prisma/adapter-pg pg
npm install --save-dev @types/pg
```
```ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```
Do NOT add a `url` back into `prisma/schema.prisma` — `prisma migrate dev` reads the URL from `prisma7.config.ts` and works as-is. `Prisma.Decimal` is available via `import { Prisma } from '@prisma/client'`; the `@prisma/client/runtime/library` path used in later plan text must be verified against 7.10 (use the `Prisma` namespace form if it doesn't resolve). If `next build` fails to trace the client's `.wasm` asset, add `serverExternalPackages: ['@prisma/client']` to `next.config.ts` — only if it actually breaks.

- [ ] **Step 3: Generate Better Auth's Prisma schema**

```bash
npx @better-auth/cli generate
```
Expected: `prisma/schema.prisma` gains `model User`, `model Session`, `model Account`, `model Verification`, with the five additional fields present on `User`. **`model Account` here is Better Auth's own OAuth/credential-linking table — it is not the financial account concept.** Phase 2 introduces `model FinancialAccount` specifically to avoid colliding with this name (§3, §4.3 of the spec). Do not rename Better Auth's generated `Account` model.

- [ ] **Step 4: Create the initial migration and apply it**

This is the first migration containing real models — Phase 0's `prisma db push` was only the one-time empty-schema connectivity check and is not used again. From here on, every schema change in every phase goes through a proper migration.
```bash
npx prisma migrate dev --name init
```
Expected: succeeds, creates `prisma/migrations/<timestamp>_init/`, applies it, regenerates the client; `User`, `Session`, `Account`, `Verification` tables exist in the local Postgres database.

- [ ] **Step 5: Mount the Better Auth route handler**

`app/api/auth/[...all]/route.ts`:
```ts
import { auth } from '@/lib/auth/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const { GET, POST } = toNextJsHandler(auth)
```

- [ ] **Step 6: Commit**

```bash
git add lib/auth lib/prisma.ts app/api/auth prisma/schema.prisma prisma/migrations package.json package-lock.json
git commit -m "feat: configure Better Auth with Prisma adapter and additional user fields"
```

---

## Task 2: `requireUser()` and the protected route group

**Files:**
- Create: `lib/auth/require-user.ts`, `app/(app)/layout.tsx`
- Modify: `app/page.tsx` (redirect logic)

**Interfaces:**
- Consumes: `auth` (Task 1)
- Produces: `requireUser(): Promise<User>` (throws `UnauthorizedError` if no session) — every service function in every later phase calls this first, before running any query; `getOptionalSession(): Promise<Session | null>` — used by the `(app)` layout and any page that behaves differently for logged-in vs anonymous visitors

- [ ] **Step 1: Write the session helpers**

`lib/auth/require-user.ts`:
```ts
import { headers } from 'next/headers'
import { auth } from '@/lib/auth/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

export async function getOptionalSession() {
  return auth.api.getSession({ headers: await headers() })
}

export async function requireUser() {
  const session = await getOptionalSession()
  if (!session?.user) throw new UnauthorizedError()
  return session.user
}
```

- [ ] **Step 2: Write the protected layout**

`app/(app)/layout.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { getOptionalSession } from '@/lib/auth/require-user'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getOptionalSession()
  if (!session?.user) redirect('/login')
  return <div className="min-h-screen bg-background">{children}</div>
}
```
This is a placeholder shell — the real sidebar/mobile nav (`AppShell`) is built in Phase 4 alongside the dashboard. For now it only proves the redirect gate works.

- [ ] **Step 3: Add a placeholder protected page**

`app/(app)/dashboard/page.tsx`:
```tsx
export default function DashboardPage() {
  return <p>Dashboard placeholder — Phase 1 protected route check</p>
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Visit `http://localhost:3000/dashboard` while logged out — confirm redirect to `/login` (which doesn't exist as a real page yet; a 404 at `/login` is acceptable for this step, the redirect itself is what's being verified — check the browser's address bar changed to `/login`).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/require-user.ts "app/(app)"
git commit -m "feat: add requireUser helper and protected route group"
```

---

## Task 3: Register

**Files:**
- Create: `lib/auth/client.ts`, `app/(auth)/register/page.tsx`, `components/auth/register-form.tsx`, `lib/validation/auth.ts`

**Interfaces:**
- Consumes: `authClient` (this task, used by Login in Task 4 too)
- Produces: `registerSchema: ZodSchema` (`lib/validation/auth.ts`) — reused by any future admin/testing tooling that needs the same shape

- [ ] **Step 1: Create the Better Auth client**

```bash
npm install
```
`lib/auth/client.ts`:
```ts
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient()
```
No `baseURL` is needed — the client and the Better Auth route handler are served from the same Next.js origin.

- [ ] **Step 2: Write the shared validation schema**

`lib/validation/auth.ts`:
```ts
import { z } from 'zod'

export const registerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
})

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
```

- [ ] **Step 3: Write the register form**

`components/auth/register-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { registerSchema, type RegisterInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RegisterForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })

  async function onSubmit(values: RegisterInput) {
    const { error } = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
    })
    if (error) {
      setError('root', { message: error.message ?? 'Registration failed' })
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input placeholder="Name" {...register('name')} />
        {errors.name && <p className="text-sm text-negative">{errors.name.message}</p>}
      </div>
      <div>
        <Input type="email" placeholder="Email" {...register('email')} />
        {errors.email && <p className="text-sm text-negative">{errors.email.message}</p>}
      </div>
      <div>
        <Input type="password" placeholder="Password" {...register('password')} />
        {errors.password && <p className="text-sm text-negative">{errors.password.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 4: Write the page**

`app/(auth)/register/page.tsx`:
```tsx
import { RegisterForm } from '@/components/auth/register-form'

export default function RegisterPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Create your CashFlow account</h1>
      <RegisterForm />
    </div>
  )
}
```

- [ ] **Step 5: Verify default rows get seeded at registration**

This step depends on `DEFAULT_ACCOUNT_TYPES`/`DEFAULT_CATEGORIES` seeding, which requires the `AccountType`/`Category` models from Phase 2 — **defer the seeding hook itself to Phase 2 Task 1**, but register the extension point now: add a `databaseHooks.user.create.after` callback in `lib/auth/auth.ts` that is currently a no-op with a comment marking where Phase 2 wires in default-row seeding.

In `lib/auth/auth.ts`, add:
```ts
databaseHooks: {
  user: {
    create: {
      after: async (user) => {
        // Phase 2 Task 1 seeds DEFAULT_ACCOUNT_TYPES and DEFAULT_CATEGORIES for `user.id` here.
      },
    },
  },
},
```

- [ ] **Step 6: Manual verification**

Run `npm run dev`, visit `/register`, submit a real test registration. Confirm redirect to `/dashboard` and that a `User` row now exists in Postgres (`npx prisma studio` or a direct `psql` check).

- [ ] **Step 7: Commit**

```bash
git add lib/auth/client.ts lib/validation/auth.ts "app/(auth)/register" components/auth/register-form.tsx lib/auth/auth.ts
git commit -m "feat: add registration flow"
```

---

## Task 4: Login and Logout

**Files:**
- Create: `app/(auth)/login/page.tsx`, `components/auth/login-form.tsx`, `components/auth/logout-button.tsx`

**Interfaces:**
- Consumes: `authClient` (Task 3), `loginSchema` (Task 3)
- Produces: `<LogoutButton />` — used by the real `AppShell` nav built in Phase 4

- [ ] **Step 1: Write the login form**

`components/auth/login-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { loginSchema, type LoginInput } from '@/lib/validation/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) })

  async function onSubmit(values: LoginInput) {
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    })
    if (error) {
      setError('root', { message: 'Invalid email or password' })
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <Input type="email" placeholder="Email" {...register('email')} />
        {errors.email && <p className="text-sm text-negative">{errors.email.message}</p>}
      </div>
      <div>
        <Input type="password" placeholder="Password" {...register('password')} />
        {errors.password && <p className="text-sm text-negative">{errors.password.message}</p>}
      </div>
      {errors.root && <p className="text-sm text-negative">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <a href="/forgot-password" className="text-sm text-accent underline">
        Forgot password?
      </a>
    </form>
  )
}
```

- [ ] **Step 2: Write the login page**

`app/(auth)/login/page.tsx`:
```tsx
import { LoginForm } from '@/components/auth/login-form'

export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Sign in to CashFlow</h1>
      <LoginForm />
    </div>
  )
}
```

- [ ] **Step 3: Write the logout button**

`components/auth/logout-button.tsx`:
```tsx
'use client'

import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'

export function LogoutButton() {
  const router = useRouter()

  async function handleLogout() {
    await authClient.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <Button variant="outline" onClick={handleLogout}>
      Log out
    </Button>
  )
}
```

- [ ] **Step 4: Wire logout into the placeholder dashboard for now**

Update `app/(app)/dashboard/page.tsx` to render `<LogoutButton />` alongside the placeholder text (temporary — Phase 4 moves this into the real `AppShell`).

- [ ] **Step 5: Manual verification**

Log in with the test account from Task 3. Confirm redirect to `/dashboard`. Click "Log out," confirm redirect to `/login`, then confirm visiting `/dashboard` again redirects back to `/login`.

- [ ] **Step 6: Commit**

```bash
git add "app/(auth)/login" components/auth/login-form.tsx components/auth/logout-button.tsx "app/(app)/dashboard/page.tsx"
git commit -m "feat: add login and logout"
```

---

## Task 5: EmailSender abstraction

**Files:**
- Create: `lib/email/sender.ts`, `lib/email/console-sender.ts`, `lib/email/smtp-sender.ts`, `lib/email/send-reset-password-email.ts`
- Test: `lib/email/sender.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `EmailSender` interface + `getEmailSender(): EmailSender` factory + `sendResetPasswordEmail` — Task 6 wires this into Better Auth's config for the first time (it doesn't exist before this task, so there's nothing to stub or replace); any later phase needing to send email also goes through this

- [ ] **Step 1: Write the interface and a failing test for provider selection**

`lib/email/sender.ts`:
```ts
export interface EmailMessage {
  to: string
  subject: string
  html: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}
```

`lib/email/sender.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('getEmailSender', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns the console sender when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '')
    const { getEmailSender } = await import('./get-sender')
    const { ConsoleEmailSender } = await import('./console-sender')
    expect(getEmailSender()).toBeInstanceOf(ConsoleEmailSender)
  })

  it('returns the SMTP sender when SMTP is configured', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_PORT', '587')
    vi.stubEnv('SMTP_USER', 'user')
    vi.stubEnv('SMTP_PASSWORD', 'pass')
    const { getEmailSender } = await import('./get-sender')
    const { SmtpEmailSender } = await import('./smtp-sender')
    expect(getEmailSender()).toBeInstanceOf(SmtpEmailSender)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run lib/email/sender.test.ts`
Expected: FAIL — `./get-sender` does not exist yet.

- [ ] **Step 3: Implement the two adapters and the factory**

`lib/email/console-sender.ts`:
```ts
import type { EmailSender, EmailMessage } from './sender'

export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log('--- DEV EMAIL ---')
    console.log(`To: ${message.to}`)
    console.log(`Subject: ${message.subject}`)
    console.log(message.html)
    console.log('-----------------')
  }
}
```

`lib/email/smtp-sender.ts`:
```ts
import nodemailer from 'nodemailer'
import type { EmailSender, EmailMessage } from './sender'

export class SmtpEmailSender implements EmailSender {
  private transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  })

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
    })
  }
}
```

`lib/email/get-sender.ts`:
```ts
import type { EmailSender } from './sender'
import { ConsoleEmailSender } from './console-sender'
import { SmtpEmailSender } from './smtp-sender'

export function getEmailSender(): EmailSender {
  if (process.env.SMTP_HOST) {
    return new SmtpEmailSender()
  }
  return new ConsoleEmailSender()
}
```

```bash
npm install nodemailer
npm install --save-dev @types/nodemailer
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run lib/email/sender.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Implement `sendResetPasswordEmail`**

`lib/email/send-reset-password-email.ts`:
```ts
import { getEmailSender } from './get-sender'

export async function sendResetPasswordEmail(to: string, resetUrl: string): Promise<void> {
  await getEmailSender().send({
    to,
    subject: 'Reset your CashFlow password',
    html: `<p>Click the link below to reset your CashFlow password. This link expires soon and can only be used once.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  })
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/email package.json package-lock.json
git commit -m "feat: add EmailSender abstraction with console and SMTP adapters"
```

---

## Task 6: Forgot password / reset password pages

**Files:**
- Modify: `lib/auth/auth.ts` (adds the `sendResetPassword` callback, deferred from Task 1 until this real dependency exists)
- Create: `app/(auth)/forgot-password/page.tsx`, `components/auth/forgot-password-form.tsx`, `app/(auth)/reset-password/[token]/page.tsx`, `components/auth/reset-password-form.tsx`

**Interfaces:**
- Consumes: `authClient` (Task 3), `sendResetPasswordEmail` (Task 5)
- Produces: nothing new — this is the point where Forgot Password becomes real, end to end, in a single task

- [ ] **Step 1: Wire the reset-password callback into the Better Auth config**

In `lib/auth/auth.ts`, add the import and the callback that Task 1 deliberately left out:
```ts
import { sendResetPasswordEmail } from '@/lib/email/send-reset-password-email'
```
```ts
emailAndPassword: {
  enabled: true,
  requireEmailVerification: false,
  sendResetPassword: async ({ user, url }) => {
    await sendResetPasswordEmail(user.email, url)
  },
},
```

- [ ] **Step 2: Forgot-password form**

`components/auth/forgot-password-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await authClient.forgetPassword({ email, redirectTo: '/reset-password' })
    setSubmitted(true)
  }

  if (submitted) {
    return <p>If an account exists for that email, a reset link has been sent.</p>
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Button type="submit">Send reset link</Button>
    </form>
  )
}
```
The response is intentionally identical whether or not the email exists (Better Auth's `forgetPassword` behaves this way by default) — this avoids leaking which emails are registered.

- [ ] **Step 3: Forgot-password page**

`app/(auth)/forgot-password/page.tsx`:
```tsx
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <ForgotPasswordForm />
    </div>
  )
}
```

- [ ] **Step 4: Reset-password form**

`components/auth/reset-password-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { error } = await authClient.resetPassword({ newPassword: password, token })
    if (error) {
      setError(error.message ?? 'Reset link is invalid or expired')
      return
    }
    router.push('/login')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        type="password"
        placeholder="New password"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <p className="text-sm text-negative">{error}</p>}
      <Button type="submit">Set new password</Button>
    </form>
  )
}
```

- [ ] **Step 5: Reset-password page**

`app/(auth)/reset-password/[token]/page.tsx`:
```tsx
import { ResetPasswordForm } from '@/components/auth/reset-password-form'

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-xl font-semibold">Set a new password</h1>
      <ResetPasswordForm token={token} />
    </div>
  )
}
```
Confirm the `redirectTo` in Step 2 (`/reset-password`) matches Better Auth's actual reset-link format — it should produce a URL like `/reset-password/<token>` or append `?token=<token>` depending on the installed version. **Verify against the actual email logged by the console adapter in Step 6 below and adjust the route/param extraction to match** — do not assume the URL shape without checking the real output.

- [ ] **Step 6: End-to-end manual verification with the console adapter**

Ensure `.env` has no `SMTP_HOST` set (so `getEmailSender()` returns `ConsoleEmailSender`). Run `npm run dev`. Go to `/forgot-password`, submit the test account's email from Task 3. Check the terminal running `npm run dev` — confirm the "DEV EMAIL" block appears with a real reset URL. Copy that URL into the browser, set a new password, confirm redirect to `/login`, then log in with the new password successfully.

- [ ] **Step 7: Verification before commit**

```bash
npm run lint
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add lib/auth/auth.ts "app/(auth)/forgot-password" "app/(auth)/reset-password" components/auth/forgot-password-form.tsx components/auth/reset-password-form.tsx
git commit -m "feat: wire real reset-password email delivery and add forgot/reset password flows"
```

---

## Task 7: Change password + profile settings

**Files:**
- Create: `app/(app)/settings/page.tsx`, `components/settings/change-password-form.tsx`, `components/settings/profile-form.tsx`, `lib/server/actions/update-profile.ts`, `lib/validation/profile.ts`

**Interfaces:**
- Consumes: `requireUser` (Task 2)
- Produces: `updateProfile(input: ProfileInput): Promise<void>` server action — this is the **only** write path to `baseCurrency`/`locale`/`theme`/`timezone`; it never accepts `isDemo`, satisfying the spec's second isolation layer for that field

- [ ] **Step 1: Write the profile validation schema — deliberately excluding `isDemo`**

`lib/validation/profile.ts`:
```ts
import { z } from 'zod'

export const profileSchema = z.object({
  name: z.string().min(1).max(100),
  baseCurrency: z.enum(['VND', 'USD']),
  locale: z.enum(['vi', 'en']),
  theme: z.enum(['light', 'dark']),
  timezone: z.string().min(1),
})

export type ProfileInput = z.infer<typeof profileSchema>
```

- [ ] **Step 2: Write the change-password form (uses Better Auth's client directly)**

`components/settings/change-password-form.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    })
    setMessage(error ? (error.message ?? 'Could not change password') : 'Password updated')
    if (!error) {
      setCurrentPassword('')
      setNewPassword('')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        type="password"
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
      />
      <Input
        type="password"
        placeholder="New password"
        minLength={8}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
      />
      {message && <p className="text-sm">{message}</p>}
      <Button type="submit">Change password</Button>
    </form>
  )
}
```

- [ ] **Step 3: Write the profile server action**

`lib/server/actions/update-profile.ts`:
```ts
'use server'

import { requireUser } from '@/lib/auth/require-user'
import { prisma } from '@/lib/prisma'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'

export async function updateProfile(input: ProfileInput): Promise<void> {
  const user = await requireUser()
  const parsed = profileSchema.parse(input)

  await prisma.user.update({
    where: { id: user.id },
    data: {
      name: parsed.name,
      baseCurrency: parsed.baseCurrency,
      locale: parsed.locale,
      theme: parsed.theme,
      timezone: parsed.timezone,
    },
  })
}
```
Note the `data:` object is built field-by-field from `parsed`, never `...parsed` spread — this is the second of the two defense-in-depth layers against a client ever setting `isDemo` (the field simply has no path into this object even if a malformed request body somehow contained it, since `profileSchema` doesn't declare it and `parse()` strips unknown keys by default).

- [ ] **Step 4: Write the profile form**

`components/settings/profile-form.tsx`:
```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { updateProfile } from '@/lib/server/actions/update-profile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ProfileForm({ defaultValues }: { defaultValues: ProfileInput }) {
  const {
    register,
    handleSubmit,
    formState: { isSubmitting, isDirty },
  } = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues })

  async function onSubmit(values: ProfileInput) {
    await updateProfile(values)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <Input placeholder="Name" {...register('name')} />
      <select {...register('baseCurrency')} className="rounded-md border p-2">
        <option value="VND">VND</option>
        <option value="USD">USD</option>
      </select>
      <select {...register('locale')} className="rounded-md border p-2">
        <option value="vi">Tiếng Việt</option>
        <option value="en">English</option>
      </select>
      <select {...register('theme')} className="rounded-md border p-2">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <Input placeholder="Timezone (IANA, e.g. Asia/Ho_Chi_Minh)" {...register('timezone')} />
      <Button type="submit" disabled={isSubmitting || !isDirty}>
        Save changes
      </Button>
    </form>
  )
}
```

- [ ] **Step 5: Write the settings page**

`app/(app)/settings/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { ProfileForm } from '@/components/settings/profile-form'
import { ChangePasswordForm } from '@/components/settings/change-password-form'

export default async function SettingsPage() {
  const user = await requireUser()
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-6">
      <section>
        <h2 className="mb-4 text-lg font-semibold">Profile</h2>
        <ProfileForm
          defaultValues={{
            name: user.name,
            baseCurrency: (user as typeof user & { baseCurrency: 'VND' | 'USD' }).baseCurrency,
            locale: (user as typeof user & { locale: 'vi' | 'en' }).locale,
            theme: (user as typeof user & { theme: 'light' | 'dark' }).theme,
            timezone: (user as typeof user & { timezone: string }).timezone,
          }}
        />
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Change password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  )
}
```
The `as typeof user & {...}` casts are a stopgap until Better Auth's additional-fields type inference is confirmed working end-to-end (see Task 1's version-verification note) — if `npx @better-auth/cli generate` combined with the client's type inference already exposes these fields without casting, remove the casts.

- [ ] **Step 6: Manual verification**

Log in, visit `/settings`, change the theme/locale/timezone, save, reload the page, confirm the new values persisted (query the `User` row directly to check). Change the password via the form, log out, log back in with the new password.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/settings" components/settings lib/server/actions/update-profile.ts lib/validation/profile.ts
git commit -m "feat: add change-password and profile settings"
```

---

## Task 8: Auth rate limiting

**Files:**
- Modify: `lib/auth/auth.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new — this hardens Task 1's config, no new exports

- [ ] **Step 1: Enable Better Auth's rate limiting**

In `lib/auth/auth.ts`, add:
```ts
rateLimit: {
  enabled: true,
  window: 60,
  max: 10,
},
```
Consult the installed Better Auth version's docs for whether per-path overrides are supported (e.g. a stricter limit specifically on `/sign-in` and `/forget-password`); if so, add a tighter rule (e.g. 5 attempts per 60s) for those two paths specifically, since they're the two most brute-forceable. If per-path rules aren't available in the installed version, the single global rule above still satisfies "sensible authentication rate limiting" from the spec.

- [ ] **Step 2: Verify**

Script or manually repeat a failed login attempt (wrong password) more than the configured `max` within the `window` — confirm the response changes to a rate-limit rejection (typically HTTP 429) rather than continuing to evaluate credentials.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/auth.ts
git commit -m "feat: enable rate limiting on auth endpoints"
```

---

## Task 9: End-to-end auth verification (Playwright)

**Files:**
- Create: `playwright.config.ts`, `e2e/auth.spec.ts`

**Interfaces:**
- Consumes: the full auth flow built in Tasks 1–8
- Produces: nothing new — this is the phase's acceptance check

- [ ] **Step 1: Install and configure Playwright**

```bash
npm init playwright@latest -- --quiet --browser=chromium
```
Confirm `playwright.config.ts` sets `baseURL: 'http://localhost:3000'` and `webServer` to run `npm run dev` automatically for test runs.

- [ ] **Step 2: Write the failing E2E test**

`e2e/auth.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('register, log out, forgot password via console email, reset, and log in', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`

  await page.goto('/register')
  await page.getByPlaceholder('Name').fill('E2E Test User')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill('correct-horse-battery-staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard/)

  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.goto('/forgot-password')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByText(/reset link has been sent/i)).toBeVisible()

  // The reset URL is only observable via the dev server's console output in this adapter —
  // this test cannot read that stream directly. Document this as a manual-verification gap
  // (already covered by Task 6 Step 5) rather than fabricating a way to intercept server stdout
  // from a browser-driven Playwright test.
})
```

- [ ] **Step 3: Run and verify what passes**

Run: `npx playwright test e2e/auth.spec.ts`
Expected: the register → logout → forgot-password-submitted portion passes. The full reset-link round trip stays a documented manual check (Task 6 Step 5) — noted here rather than silently dropped, since automating a check of server stdout from a Playwright test would need infrastructure (e.g. an SMTP test-catcher, or an adapter-specific test hook) not currently in scope for the MVP.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json
git commit -m "test: add Playwright E2E coverage for register/logout/forgot-password"
```

---

## Phase 1 Acceptance Check

- [ ] A new user can register, is redirected to `/dashboard`, and default `AccountType`/`Category` rows are ready to be seeded once Phase 2 wires the hook added in Task 3.
- [ ] A logged-out visitor hitting `/dashboard` or `/settings` is redirected to `/login`.
- [ ] Forgot password produces a real, observable reset link via the console adapter in dev, and completing it changes the password (verified end-to-end in Task 6 Step 5).
- [ ] Change password and profile preference updates (currency/locale/theme/timezone) persist correctly.
- [ ] `isDemo` has no path from any client input to the database — verified by inspection of `additionalFields` (`input: false`) and `updateProfile`'s explicit field-by-field `data:` object.
- [ ] Repeated failed logins are rate-limited.
- [ ] `npm run test`, `npm run lint`, `npm run build`, and `npx playwright test` all succeed.

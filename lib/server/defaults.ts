import { prisma } from '@/lib/prisma'

/**
 * The starter AccountType and Category rows every new user gets, so the app is
 * usable the moment registration finishes (§4.2 of the spec). They are ordinary
 * per-user rows — `isDefault: true` only marks where they came from; the user
 * can rename, archive or add to them freely.
 */
export const DEFAULT_ACCOUNT_TYPES = [
  'Cash',
  'Bank Account',
  'E-wallet',
  'Savings Account',
  'Other',
]

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transportation',
  'Shopping',
  'Entertainment',
  'Bills & Utilities',
  'Health',
  'Education',
  'Family',
  'Travel',
  'Other',
]

export const DEFAULT_INCOME_CATEGORIES = [
  'Salary',
  'Bonus',
  'Freelance',
  'Investment Income',
  'Gift',
  'Other',
]

/**
 * Seeds one user's default account types and categories.
 *
 * Called from the Better Auth `user.create.after` hook wired up in
 * `lib/auth/create-auth.ts`. Missing rows are filled in one name at a time —
 * an account type is "already there" for a (userId, name) and a category for a
 * (userId, name, type), regardless of `isDefault` or `status`. So a retried
 * registration cannot double the defaults, a run that died halfway through
 * finishes the job next time, and a row the user made themselves that happens
 * to carry a default name is left exactly as it is rather than being shadowed
 * by a second row with the same name.
 *
 * This is the same rule the `backfill_default_taxonomy` migration applies to
 * users who registered before this hook existed; keep the two in step.
 */
export async function seedDefaultsForUser(userId: string): Promise<void> {
  const [existingAccountTypes, existingCategories] = await Promise.all([
    prisma.accountType.findMany({ where: { userId }, select: { name: true } }),
    prisma.category.findMany({ where: { userId }, select: { name: true, type: true } }),
  ])

  const takenAccountTypeNames = new Set(existingAccountTypes.map((row) => row.name))
  const takenCategoryKeys = new Set(existingCategories.map((row) => `${row.type}:${row.name}`))

  const missingAccountTypes = DEFAULT_ACCOUNT_TYPES.filter(
    (name) => !takenAccountTypeNames.has(name),
  ).map((name) => ({ userId, name, isDefault: true }))

  const missingCategories = [
    ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
      userId,
      name,
      type: 'EXPENSE' as const,
      isDefault: true,
    })),
    ...DEFAULT_INCOME_CATEGORIES.map((name) => ({
      userId,
      name,
      type: 'INCOME' as const,
      isDefault: true,
    })),
  ].filter((row) => !takenCategoryKeys.has(`${row.type}:${row.name}`))

  if (missingAccountTypes.length > 0) {
    await prisma.accountType.createMany({ data: missingAccountTypes })
  }
  if (missingCategories.length > 0) {
    await prisma.category.createMany({ data: missingCategories })
  }
}

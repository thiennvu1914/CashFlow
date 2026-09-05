import { prisma } from '@/lib/prisma'

/**
 * The starter AccountType and Category rows every new user gets, so the app is
 * usable the moment registration finishes (§4.3 of the spec). They are ordinary
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
 * `lib/auth/auth.ts`. Each table is skipped when the user already has rows in
 * it, so a retried registration cannot double the defaults — and a run that
 * died between the two writes still finishes the job on the next attempt.
 */
export async function seedDefaultsForUser(userId: string): Promise<void> {
  if ((await prisma.accountType.count({ where: { userId } })) === 0) {
    await prisma.accountType.createMany({
      data: DEFAULT_ACCOUNT_TYPES.map((name) => ({ userId, name, isDefault: true })),
    })
  }

  if ((await prisma.category.count({ where: { userId } })) === 0) {
    await prisma.category.createMany({
      data: [
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
      ],
    })
  }
}

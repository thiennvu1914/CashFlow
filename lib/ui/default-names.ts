/**
 * Display names for the starter categories and account types (`lib/server/defaults.ts`).
 *
 * The stored name stays English — it is what the Excel export, the seed's
 * "already there" check and the loan-interest lookup match on — so translation
 * happens only here, at render time. A row is translated only when it is a
 * default AND its stored name is one of the known defaults: a user-created row,
 * or a default the user renamed, shows exactly what is stored.
 */
type Translate = (key: string) => string

const CATEGORY_KEYS: Record<string, string> = {
  'Food & Dining': 'foodDining',
  Transportation: 'transportation',
  Shopping: 'shopping',
  Entertainment: 'entertainment',
  'Bills & Utilities': 'billsUtilities',
  Health: 'health',
  Education: 'education',
  Family: 'family',
  Travel: 'travel',
  'Loan Interest & Fees': 'loanInterestFees',
  Salary: 'salary',
  Bonus: 'bonus',
  Freelance: 'freelance',
  'Investment Income': 'investmentIncome',
  Gift: 'gift',
  Other: 'other',
}

const ACCOUNT_TYPE_KEYS: Record<string, string> = {
  Cash: 'cash',
  'Bank Account': 'bankAccount',
  'E-wallet': 'eWallet',
  'Savings Account': 'savingsAccount',
  Other: 'other',
}

interface Named {
  name: string
  isDefault: boolean
}

function display(
  row: Named,
  keys: Record<string, string>,
  group: 'category' | 'accountType',
  t: Translate,
): string {
  if (!row.isDefault) return row.name
  const key = Object.hasOwn(keys, row.name) ? keys[row.name] : undefined
  return key ? t(`categories.defaultNames.${group}.${key}`) : row.name
}

export function displayCategoryName(row: Named, t: Translate): string {
  return display(row, CATEGORY_KEYS, 'category', t)
}

export function displayAccountTypeName(row: Named, t: Translate): string {
  return display(row, ACCOUNT_TYPE_KEYS, 'accountType', t)
}

/** For the DTOs that carry a nullable `categoryName` beside a `categoryIsDefault` flag. */
export function displayCategoryLabel(
  name: string | null,
  isDefault: boolean,
  t: Translate,
): string | null {
  return name === null ? null : displayCategoryName({ name, isDefault }, t)
}

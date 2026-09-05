export function AccountList({
  accounts,
}: {
  accounts: { id: string; name: string; currency: string; accountType: { name: string } }[]
}) {
  if (accounts.length === 0) {
    return <p className="text-sm text-foreground/60">No accounts yet — add one below.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {accounts.map((account) => (
        <li key={account.id} className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="font-medium">{account.name}</p>
            <p className="text-sm text-foreground/60">
              {account.accountType.name} · {account.currency}
            </p>
          </div>
          <span className="tabular-nums">— {/* wired to getAccountBalance in Task 11 */}</span>
        </li>
      ))}
    </ul>
  )
}

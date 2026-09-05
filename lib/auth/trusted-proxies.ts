/**
 * Parses the `TRUSTED_PROXY_CIDRS` environment variable into the list Better
 * Auth's `advanced.ipAddress.trustedProxies` option expects.
 *
 * The value is a comma-separated list of IP addresses or CIDR ranges naming the
 * reverse proxies / CDN nodes that sit in front of this app and append to
 * `x-forwarded-for`. Better Auth walks the forwarded chain right to left,
 * skipping hops that match one of these entries, and takes the first untrusted
 * address as the client IP (`getIPFromHeader` in
 * `node_modules/@better-auth/core/dist/utils/ip.mjs`). Without it, only a
 * single-value `x-forwarded-for` is trusted at all — which is both spoofable by
 * a direct client and useless behind an appending proxy, where the chain
 * resolves to `null` and every caller shares one rate-limit bucket.
 *
 * Kept in its own module (rather than inline in `lib/auth/auth.ts`) so it is
 * testable without importing the app's Prisma-backed auth singleton.
 *
 * Invalid entries are deliberately NOT filtered here: Better Auth validates
 * them itself at construction and logs
 * `Ignoring invalid \`advanced.ipAddress.trustedProxies\` entries: …`
 * (`node_modules/better-auth/dist/context/create-context.mjs`). Dropping them
 * silently here would hide that warning from an operator who typo'd a CIDR.
 */
export function parseTrustedProxies(value: string | undefined): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

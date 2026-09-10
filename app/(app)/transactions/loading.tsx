import { PageSkeleton } from '@/components/common/page-skeleton'

/** Transactions' geometry: max-w 1200 and the 7/12 + 5/12 desktop split. */
export default function Loading() {
  return <PageSkeleton maxWidth="max-w-[75rem]" rows={8} twoColumn />
}

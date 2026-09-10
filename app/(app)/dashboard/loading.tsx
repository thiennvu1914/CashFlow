import { PageSkeleton } from '@/components/common/page-skeleton'

/** The dashboard's geometry: max-w 1200, the summary panel, then the grid. */
export default function Loading() {
  return <PageSkeleton maxWidth="max-w-[75rem]" summary="panel" rows={8} />
}

import { PageSkeleton } from '@/components/common/page-skeleton'

/** Reports' geometry: max-w 1200 and the three-figure summary strip. */
export default function Loading() {
  return <PageSkeleton maxWidth="max-w-[75rem]" summary="strip" rows={5} />
}

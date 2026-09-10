import { cn } from 'cn'
import { Skeleton } from './skeleton'

/**
 * A page's shape, in grey (spec §10: "grey bars in the real layout, no
 * spinners").
 *
 * A spinner says "something is happening"; a skeleton says "a header, a summary
 * and eight rows are happening", which is the difference between waiting and
 * knowing. And because it occupies the real geometry — the same max width, the
 * same padding, the same card — the content does not jump when it arrives.
 *
 * No text at all, deliberately: "Đang tải…" under grey bars adds nothing the
 * bars do not already say, and it would be the one string that flashes on every
 * navigation in the app. (It is also the one thing a `loading.tsx` cannot
 * translate cheaply per route without a translator on a file that exists to
 * render instantly.)
 *
 * `aria-hidden` on every bar (from `Skeleton`): this is decoration standing in
 * for content, and announcing it twelve times per session is worse than
 * silence — the route transition itself is what a screen reader announces. The
 * region carries `aria-busy="true"` (owner item H5) so an assistive technology
 * that asks "is this still loading?" gets an answer, without anything
 * announcing itself unprompted.
 */
export function PageSkeleton({
  rows = 6,
  summary = 'none',
  twoColumn = false,
  maxWidth = 'max-w-[60rem]',
}: {
  /** How many placeholder rows the list card shows. */
  rows?: number
  /** Add a summary strip above the list — dashboard and reports. */
  summary?: 'panel' | 'strip' | 'none'
  /** Add a second column for the pages that have one. */
  twoColumn?: boolean
  /** The page's max width class, so the skeleton occupies the real geometry. */
  maxWidth?: string
}) {
  return (
    <div
      aria-busy="true"
      className={cn('mx-auto flex w-full flex-col gap-8 p-4 md:p-6 lg:p-8', maxWidth)}
    >
      {/* The header: a title bar and a subtitle bar, at the real sizes. */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {summary === 'panel' && (
        <div className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-2 xl:grid-cols-12">
          <div className="flex flex-col gap-2 p-4 xl:col-span-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-40" />
          </div>
          <div className="grid grid-cols-2 gap-px border-t border-border md:grid-cols-3 xl:col-span-8 xl:border-t-0">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-28" />
              </div>
            ))}
          </div>
        </div>
      )}

      {summary === 'strip' && (
        <div className="grid grid-cols-1 gap-px rounded-lg border border-border bg-surface md:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex flex-col gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </div>
      )}

      <div className={cn('grid grid-cols-1 gap-8', twoColumn && 'xl:grid-cols-12')}>
        <div className={cn(twoColumn && 'xl:col-span-7')}>
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <ul className="divide-y divide-border">
              {Array.from({ length: rows }, (_, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                  <Skeleton className="h-5 w-24" />
                </li>
              ))}
            </ul>
          </div>
        </div>
        {twoColumn && (
          <div className="hidden xl:col-span-5 xl:block">
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
              <Skeleton className="h-5 w-32" />
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-11 w-full" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

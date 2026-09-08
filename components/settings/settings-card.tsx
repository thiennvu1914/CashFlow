import { SectionHeader } from '@/components/common/section-header'

/**
 * One settings card (spec §6.9): a titled bordered surface holding a group of
 * fields.
 *
 * It is deliberately NOT "a card plus its own Save": the amended spec has three
 * visual cards but two forms, because Hồ sơ and Tùy chọn are five fields of one
 * `updateProfile` call and two Saves posting the whole `ProfileInput` would race
 * — whichever landed second would write back the other's pre-change values. So
 * this component draws the surface and the heading; the FORM decides where its
 * one Save goes.
 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
      <SectionHeader title={title} caption={description} />
      {children}
    </section>
  )
}

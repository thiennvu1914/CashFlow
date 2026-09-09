'use client'

import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { profileSchema, type ProfileInput } from '@/lib/validation/profile'
import { updateProfile } from '@/lib/server/actions/update-profile'
import { timezoneGroups } from '@/lib/ui/timezones'
import { useHydrated } from '@/lib/ui/use-hydrated'
import { useSubmitState } from '@/lib/ui/use-submit-state'
import { GENERIC_ERROR_KEY } from '@/lib/ui/action-error-messages'
import { FormField, SELECT_CLASS } from '@/components/common/form-field'
import { InlineAlert } from '@/components/common/inline-alert'
import { SettingsCard } from '@/components/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The profile: all five fields of `updateProfile`, in two labelled groups, with
 * ONE Save (amended spec §6.9).
 *
 * Two Saves were tried and rejected. Both would have posted the whole
 * `ProfileInput` — the action's Zod schema requires every field — so a user who
 * changed the name in one card and the theme in the other, saving each, would
 * have had the second save write back the first's pre-change value. One form
 * cannot have that bug.
 *
 * The two `<fieldset>`s are the groups. They exist for three reasons at once:
 * they name each group to a screen reader through their `<legend>`, they are
 * the native mechanism the hydration gate and the in-flight lock use, and they
 * let the two visual cards sit inside one `<form>` with the Save below both.
 */
export function ProfileForm({
  defaultValues,
  email,
  labels,
}: {
  defaultValues: ProfileInput
  /** The signed-in email, shown as read-only context under Name — never
   *  editable here or anywhere else in the app, so it is not part of
   *  `ProfileInput`/`profileSchema` and is never passed to `register()`. */
  email: string
  labels: {
    profileTitle: string
    profileDescription: string
    preferencesTitle: string
    preferencesDescription: string
  }
}) {
  const router = useRouter()
  const t = useTranslations()
  const [notice, setNotice] = useState<string | null>(null)
  /** See the fieldsets below, and `lib/ui/use-hydrated.ts` for the defect. */
  const hydrated = useHydrated()
  const submit = useSubmitState()
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProfileInput>({ resolver: zodResolver(profileSchema), defaultValues })

  /**
   * The zone list, with the stored value hoisted to its own leading group.
   * `timezoneGroups` walks all ~400 `Intl.supportedValuesOf('timeZone')`
   * entries and re-sorts every region — real work worth not repeating on
   * every keystroke in the OTHER fields (Name, Base Currency, …), none of
   * which change `defaultValues.timezone`.
   */
  const groups = useMemo(() => timezoneGroups(defaultValues.timezone), [defaultValues.timezone])

  async function onSubmit(values: ProfileInput) {
    setNotice(null)
    await submit.run(async () => {
      try {
        const result = await updateProfile(values)
        if (!result.ok) {
          setError('root', { message: t(GENERIC_ERROR_KEY) })
          return
        }
      } catch {
        console.error('Profile update request failed')
        setError('root', { message: t(GENERIC_ERROR_KEY) })
        return
      }
      reset(values)
      setNotice(t('settings.profileSaved'))

      // Spec §3: the profile form applies the `dark` class immediately after a
      // successful save.
      //
      // Only after the action resolved `ok`, and only the class — the cookie and
      // the row were written by `updateProfile`, and the next server render
      // produces the same class from `resolveTheme()`. So this is not a second
      // source of truth; it is the same truth applied one navigation earlier.
      // `classList.toggle` with an explicit second argument rather than a bare
      // toggle, so a second save cannot invert it.
      document.documentElement.classList.toggle('dark', values.theme === 'dark')
      document.documentElement.style.colorScheme = values.theme

      // And the shell — the rail's labels, every figure's grouping — re-renders
      // from the database on the next server pass.
      router.refresh()
    })
  }

  /**
   * Both groups share it: `!hydrated` is the pre-hydration gate (this form is
   * the worst case — EVERY field has a `defaultValues` entry, so every field
   * was revertible), and `submit.locked` is spec §9's in-flight lock. A
   * `<fieldset disabled>` is the one native mechanism that disables everything
   * inside it, and `:disabled` matches those descendants, so the existing
   * `disabled:` styles apply with no new CSS. `min-w-0` neutralises a
   * fieldset's default `min-inline-size: min-content`, and Tailwind's preflight
   * already zeroes its margin/padding/border — so nothing shifts when the gate
   * lifts.
   */
  const fieldsetProps = {
    disabled: !hydrated || submit.locked,
    'aria-busy': submit.busy,
    className: 'flex min-w-0 flex-col gap-4',
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-8">
      <SettingsCard title={labels.profileTitle} description={labels.profileDescription}>
        <fieldset {...fieldsetProps}>
          {/* `sr-only`: the card's visible `h2` already names the group, and a
              visible legend would say it twice. */}
          <legend className="sr-only">{t('settings.profileGroup')}</legend>
          <FormField id="settings-name" label={t('settings.name')} error={errors.name?.message}>
            {(aria) => (
              // `defaultValue` (never `value` — that would make it controlled)
              // so the SERVER renders the stored name instead of an empty box,
              // and RHF's one destructive ref write agrees with the markup it
              // lands on.
              <Input {...aria} {...register('name')} defaultValue={defaultValues.name} />
            )}
          </FormField>

          {/* Owner K1: the signed-in email as read-only context — not
              editable here or anywhere else in the app, so it carries its
              own unconditional `disabled` rather than relying on the
              fieldset's (which lifts once hydrated). Not `register()`ed:
              it is not one of `ProfileInput`'s five fields, and `updateProfile`
              never accepts it. */}
          <FormField id="settings-email" label={t('settings.email')}>
            {(aria) => <Input {...aria} defaultValue={email} disabled readOnly />}
          </FormField>
        </fieldset>
      </SettingsCard>

      <SettingsCard title={labels.preferencesTitle} description={labels.preferencesDescription}>
        <fieldset {...fieldsetProps}>
          <legend className="sr-only">{t('settings.preferencesGroup')}</legend>

          <FormField
            id="settings-base-currency"
            label={t('settings.baseCurrency')}
            helper={t('settings.baseCurrencyHelper')}
            error={errors.baseCurrency?.message}
          >
            {(aria) => (
              <div className="relative">
                <select
                  {...aria}
                  {...register('baseCurrency')}
                  defaultValue={defaultValues.baseCurrency}
                  className={SELECT_CLASS}
                >
                  <option value="VND">VND</option>
                  <option value="USD">USD</option>
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
                />
              </div>
            )}
          </FormField>

          <FormField
            id="settings-locale"
            label={t('settings.locale')}
            error={errors.locale?.message}
          >
            {(aria) => (
              <div className="relative">
                <select
                  {...aria}
                  {...register('locale')}
                  defaultValue={defaultValues.locale}
                  className={SELECT_CLASS}
                >
                  {/* Each language named in ITS OWN language, deliberately: a
                      language picker that renders "Vietnamese" to someone who
                      cannot read English is the one label that must not be
                      translated. */}
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">English</option>
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
                />
              </div>
            )}
          </FormField>

          <FormField id="settings-theme" label={t('settings.theme')} error={errors.theme?.message}>
            {(aria) => (
              <div className="relative">
                <select
                  {...aria}
                  {...register('theme')}
                  defaultValue={defaultValues.theme}
                  className={SELECT_CLASS}
                >
                  <option value="light">{t('settings.themeLight')}</option>
                  <option value="dark">{t('settings.themeDark')}</option>
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
                />
              </div>
            )}
          </FormField>

          <FormField
            id="settings-timezone"
            label={t('settings.timezone')}
            helper={t('settings.timezoneHelper')}
            error={errors.timezone?.message}
          >
            {(aria) => (
              // A native `<select>` with `<optgroup>`s, not a custom combobox:
              // four hundred entries is exactly the case a phone's own picker
              // handles better than anything this app could build, and it
              // replaces the free-text input a user could type an invalid zone
              // into. `isValidIanaTimezone` still validates it server-side.
              <div className="relative">
                <select
                  {...aria}
                  {...register('timezone')}
                  defaultValue={defaultValues.timezone}
                  className={SELECT_CLASS}
                >
                  {groups.map((group) => (
                    <optgroup
                      key={group.region}
                      label={
                        group.region === 'current' ? t('settings.timezoneCurrent') : group.region
                      }
                    >
                      {group.zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
                />
              </div>
            )}
          </FormField>
        </fieldset>
      </SettingsCard>

      {/* ONE Save, below both cards, so it visibly belongs to both groups
          rather than to the one above it. `!isDirty` because a Save that does
          nothing is a Save that lies. */}
      <div className="flex flex-col gap-3">
        {errors.root && <InlineAlert tone="negative">{errors.root.message}</InlineAlert>}
        {notice && <InlineAlert tone="positive">{notice}</InlineAlert>}
        <Button
          type="submit"
          className="self-start"
          disabled={!hydrated || submit.locked || !isDirty}
        >
          {submit.pending ? t('settings.savingProfile') : t('settings.saveProfile')}
        </Button>
      </div>
    </form>
  )
}

import { useState } from 'react'
import { ArrowLeft, IdCard, KeyRound, Loader2, UserCog } from 'lucide-react'
import { authFetch, rememberProfile } from '../auth.js'

const API = '/agh/api'

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

export default function AccountSettingsPage({ user, role, firstName = '', lastName = '', displayName = '', onProfileChange, onBack }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [profile, setProfile] = useState({ firstName, lastName })
  const [saving, setSaving] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const passwordsMatch = !form.confirmPassword || form.newPassword === form.confirmPassword

  const update = patch => {
    setForm(current => ({ ...current, ...patch }))
    setMessage('')
    setError('')
  }

  const updateProfile = patch => {
    setProfile(current => ({ ...current, ...patch }))
    setMessage('')
    setError('')
  }

  const submitProfile = async event => {
    event.preventDefault()
    setSavingProfile(true)
    setMessage('')
    setError('')
    try {
      const body = await fetchJson(`${API}/account/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(profile),
      })
      const nextProfile = { firstName: body.firstName || '', lastName: body.lastName || '', displayName: body.displayName || '' }
      setProfile({ firstName: nextProfile.firstName, lastName: nextProfile.lastName })
      rememberProfile(nextProfile)
      onProfileChange?.(nextProfile)
      setMessage('Name updated')
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingProfile(false)
    }
  }

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    try {
      if (form.newPassword !== form.confirmPassword) throw new Error('New passwords do not match')
      await fetchJson(`${API}/account/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(form),
      })
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setMessage('Password updated')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell flex h-screen w-screen flex-col overflow-hidden">
      <header className="app-header flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-brand-mark"><UserCog size={15} /></span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight text-[var(--text)]">Account Settings</h1>
            <p className="truncate text-[11px] leading-tight text-[var(--text-subtle)]">{displayName || user}{role ? ` (${role})` : ''}</p>
          </div>
        </div>
        <button type="button" onClick={onBack} className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]">
          <ArrowLeft size={13} /> Viewer
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <section className="ux-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface-1)] text-sm font-semibold text-[var(--text)]">
                {(displayName || user || '?').slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--text)]">{displayName || user}</p>
                <p className="truncate text-[11px] text-[var(--text-subtle)]">{user}{role ? ` · ${role}` : ''}</p>
              </div>
            </div>
          </section>
          {(error || message) && (
            <div className={`rounded border px-3 py-2 text-xs ${error ? 'border-[var(--danger)] bg-red-950/20 text-[var(--danger)]' : 'border-green-700 bg-green-950/20 text-green-300'}`}>
              {error || message}
            </div>
          )}

        <form onSubmit={submitProfile} className="ux-card w-full p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <IdCard size={15} /> Name
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">First name</span>
              <input
                value={profile.firstName}
                onChange={event => updateProfile({ firstName: event.target.value })}
                autoComplete="given-name"
                className="ux-input"
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Last name</span>
              <input
                value={profile.lastName}
                onChange={event => updateProfile({ lastName: event.target.value })}
                autoComplete="family-name"
                className="ux-input"
                required
              />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={savingProfile}
              className="ux-button ux-button-primary"
            >
              {savingProfile ? <Loader2 size={14} className="animate-spin" /> : <UserCog size={14} />}
              Set
            </button>
          </div>
        </form>

        <form onSubmit={submit} className="ux-card w-full p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <KeyRound size={15} /> Change Password
          </div>
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Current password</span>
            <input
              type="password"
              value={form.currentPassword}
              onChange={event => update({ currentPassword: event.target.value })}
              autoComplete="current-password"
              className="ux-input"
              required
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">New password</span>
            <input
              type="password"
              value={form.newPassword}
              onChange={event => update({ newPassword: event.target.value })}
              autoComplete="new-password"
              className="ux-input"
              required
            />
          </label>
          <label className="mb-4 block">
            <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Confirm new password</span>
            <input
              type="password"
              value={form.confirmPassword}
              onChange={event => update({ confirmPassword: event.target.value })}
              autoComplete="new-password"
              className="ux-input"
              required
            />
          </label>
          {!passwordsMatch && <p className="mb-3 text-xs text-[var(--danger)]">New passwords do not match</p>}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving || !passwordsMatch}
              className="ux-button ux-button-primary"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              Set
            </button>
          </div>
        </form>
        </div>
      </main>
    </div>
  )
}

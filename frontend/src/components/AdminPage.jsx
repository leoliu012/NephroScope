import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowLeft, Loader2, RefreshCw, Shield, Trash2, UserPlus } from 'lucide-react'
import { authFetch } from '../auth.js'

const API = '/agh/api'

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`
}

function auditResultClass(result) {
  if (result === 'success') return 'text-green-400'
  if (result === 'pending') return 'text-amber-300'
  return 'text-[var(--danger)]'
}

function eventSummary(event) {
  const parts = []
  if (event.case_id) parts.push(`case ${event.case_id}`)
  if (event.filename) parts.push(event.filename)
  if (event.annotation_revision_before !== null && event.annotation_revision_before !== undefined) {
    parts.push(`rev ${event.annotation_revision_before} -> ${event.annotation_revision_after}`)
  }
  if (event.details) {
    const detail = Object.entries(event.details)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(', ')
    if (detail) parts.push(detail)
  }
  return parts.join(' | ')
}

export default function AdminPage({ currentUser, onBack }) {
  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [events, setEvents] = useState([])
  const [sync, setSync] = useState({ configured: false, state: 'disabled' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', confirmPassword: '', firstName: '', lastName: '', role: 'viewer' })
  const [passwords, setPasswords] = useState({})
  const [nameDrafts, setNameDrafts] = useState({})
  const [expandedNames, setExpandedNames] = useState({})
  const [expandedPasswords, setExpandedPasswords] = useState({})
  const sortedEvents = useMemo(() => events.slice(0, 300), [events])
  const syncProgress = sync.progress || null
  const syncPercent = Number(syncProgress?.percent)
  const hasSyncPercent = Number.isFinite(syncPercent)

  const loadAuditEvents = async () => {
    const eventData = await fetchJson(`${API}/admin/audit-events?limit=300`)
    setEvents(eventData.events || [])
  }

  const loadSyncStatus = async () => {
    const status = await fetchJson(`${API}/admin/image-sync`)
    setSync(status)
  }

  const loadAdminData = async () => {
    setLoading(true)
    setError('')
    try {
      const [userData, eventData, syncData] = await Promise.all([
        fetchJson(`${API}/admin/users`),
        fetchJson(`${API}/admin/audit-events?limit=300`),
        fetchJson(`${API}/admin/image-sync`),
      ])
      setUsers(userData.users || [])
      setRoles(userData.roles || [])
      setEvents(eventData.events || [])
      setSync(syncData)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAdminData()
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      loadAuditEvents().catch(() => {})
      loadSyncStatus().catch(() => {})
    }, 15000)
    return () => window.clearInterval(id)
  }, [])

  const addUser = async (event) => {
    event.preventDefault()
    if (newUser.password !== newUser.confirmPassword) {
      setError('New user passwords do not match')
      return
    }
    setSaving('add')
    setError('')
    try {
      await fetchJson(`${API}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(newUser),
      })
      setNewUser({ username: '', password: '', confirmPassword: '', firstName: '', lastName: '', role: 'viewer' })
      setAddOpen(false)
      const [userData] = await Promise.all([
        fetchJson(`${API}/admin/users`),
        loadAuditEvents(),
      ])
      setUsers(userData.users || [])
      setRoles(userData.roles || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving('')
    }
  }

  const updateUser = async (username, patch) => {
    setSaving(username)
    setError('')
    try {
      const data = await fetchJson(`${API}/admin/users/${encodeURIComponent(username)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      })
      setUsers(data.users || users)
      await loadAuditEvents()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving('')
    }
  }

  const deleteUser = async (username) => {
    if (!window.confirm(`Delete account "${username}"?`)) return
    setSaving(username)
    setError('')
    try {
      const data = await fetchJson(`${API}/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' })
      setUsers(data.users || [])
      await loadAuditEvents()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving('')
    }
  }

  const resetPassword = async (username) => {
    const password = passwords[username]?.password || ''
    const confirm = passwords[username]?.confirm || ''
    if (password !== confirm) {
      setError('New passwords do not match')
      return
    }
    setSaving(username)
    setError('')
    try {
      const data = await fetchJson(`${API}/admin/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password, confirmPassword: confirm }),
      })
      setUsers(data.users || users)
      setPasswords(current => ({ ...current, [username]: { password: '', confirm: '' } }))
      setExpandedPasswords(current => ({ ...current, [username]: false }))
      await loadAuditEvents().catch(() => {})
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving('')
    }
  }

  const beginNameEdit = (user) => {
    setNameDrafts(current => ({
      ...current,
      [user.username]: {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
      },
    }))
    setExpandedNames(current => ({ ...current, [user.username]: true }))
    setExpandedPasswords(current => ({ ...current, [user.username]: false }))
  }

  const cancelNameEdit = (username) => {
    setExpandedNames(current => ({ ...current, [username]: false }))
    setNameDrafts(current => ({ ...current, [username]: undefined }))
  }

  const saveName = async (username) => {
    const draft = nameDrafts[username] || {}
    await updateUser(username, { firstName: draft.firstName || '', lastName: draft.lastName || '' })
    setExpandedNames(current => ({ ...current, [username]: false }))
  }

  const beginPasswordEdit = (username) => {
    setPasswords(current => ({ ...current, [username]: { password: '', confirm: '' } }))
    setExpandedPasswords(current => ({ ...current, [username]: true }))
    setExpandedNames(current => ({ ...current, [username]: false }))
  }

  const cancelPasswordEdit = (username) => {
    setExpandedPasswords(current => ({ ...current, [username]: false }))
    setPasswords(current => ({ ...current, [username]: { password: '', confirm: '' } }))
  }

  const requestImageSync = async () => {
    setSaving('image-sync')
    setError('')
    try {
      const status = await fetchJson(`${API}/admin/image-sync`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      setSync(status)
      await loadAuditEvents().catch(() => {})
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving('')
    }
  }

  return (
    <div className="app-shell flex h-screen w-screen flex-col overflow-hidden">
      <header className="app-header flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="app-brand-mark"><Shield size={15} /></span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight text-[var(--text)]">Administration</h1>
            <p className="truncate text-[11px] leading-tight text-[var(--text-subtle)]">Signed in as {currentUser}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={loadAdminData} className="ux-button ux-button-ghost min-h-0 px-3 py-1.5 text-[11px]">
            <RefreshCw size={13} /> Refresh
          </button>
          <button type="button" onClick={onBack} className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]">
            <ArrowLeft size={13} /> Viewer
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && <div className="mb-4 rounded border border-[var(--danger)] bg-red-950/20 px-3 py-2 text-xs text-[var(--danger)]">{error}</div>}
        {loading ? (
          <div className="flex h-64 items-center justify-center text-[var(--text-subtle)]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
            <section className="space-y-4">
              <section className="ux-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
                      <RefreshCw size={15} className={sync.state === 'running' ? 'animate-spin' : ''} /> Image sync
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                      {!sync.configured
                        ? 'Remote image sync is not configured.'
                        : sync.state === 'running'
                          ? syncProgress?.phase === 'scanning'
                            ? 'Scanning the remote image folder.'
                            : 'Synchronizing the local image cache from the remote folder.'
                          : sync.manualRequestPending
                            ? 'Manual synchronization is queued; waiting for the sync worker.'
                            : `Remote-authoritative cache check every ${Math.max(1, Math.round((sync.intervalSeconds || 86400) / 3600))} hours.`}
                    </p>
                    {sync.lastSuccessAt && <p className="mt-1 text-[10px] text-[var(--text-subtle)]">Last successful sync: {formatTime(sync.lastSuccessAt)}</p>}
                    {sync.state === 'error' && sync.message && <p className="mt-1 text-[10px] text-[var(--danger)]">{sync.message}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={requestImageSync}
                    disabled={!sync.configured || saving === 'image-sync' || sync.state === 'running' || sync.manualRequestPending}
                    className="ux-button ux-button-primary min-h-0 px-3 py-1.5 text-[11px]"
                  >
                    {saving === 'image-sync' || sync.state === 'running' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    Sync now
                  </button>
                </div>
                {sync.state === 'running' && syncProgress && (
                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    <div className="flex items-center justify-between gap-3 text-[10px] text-[var(--text-subtle)]">
                      <span>
                        {syncProgress.phase === 'scanning'
                          ? 'Discovering eligible files…'
                          : `${syncProgress.completedFiles || 0} / ${syncProgress.totalFiles || 0} images checked`}
                      </span>
                      {hasSyncPercent && <span>{Math.round(syncPercent)}%</span>}
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-1)]" aria-label="Image sync progress">
                      {hasSyncPercent ? (
                        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, syncPercent))}%` }} />
                      ) : (
                        <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse" />
                      )}
                    </div>
                    <p className="mt-1.5 truncate text-[10px] text-[var(--text-subtle)]">
                      {syncProgress.currentFile ? `Current: ${syncProgress.currentFile}` : 'Preparing sync…'}
                      {syncProgress.totalBytes > 0 && ` · ${formatBytes(syncProgress.completedBytes || 0)} / ${formatBytes(syncProgress.totalBytes)}`}
                    </p>
                  </div>
                )}
                {sync.state !== 'running' && sync.counts && (
                  <p className="mt-3 text-[10px] text-[var(--text-subtle)]">
                    Last completed pass: {sync.counts.copied || 0} copied, {sync.counts.renamed || 0} renamed, {sync.counts.deleted || 0} removed, {sync.counts.deferred || 0} deferred.
                  </p>
                )}
              </section>
              <section className="ux-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
                    <UserPlus size={15} /> Add User
                  </div>
                  <button type="button" onClick={() => setAddOpen(open => !open)} className="ux-button ux-button-primary min-h-0 px-3 py-1.5 text-[11px]">
                    {addOpen ? 'Close' : 'Add user'}
                  </button>
                </div>
                {addOpen && (
                  <form onSubmit={addUser} className="mt-4 max-w-2xl space-y-3" autoComplete="off">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        value={newUser.username}
                        onChange={event => setNewUser(current => ({ ...current, username: event.target.value }))}
                        placeholder="Username"
                        autoComplete="off"
                        name="new-admin-username"
                        className="ux-input"
                        required
                      />
                      <select
                        value={newUser.role}
                        onChange={event => setNewUser(current => ({ ...current, role: event.target.value }))}
                        className="ux-select"
                      >
                        {roles.map(role => <option key={role} value={role}>{role}</option>)}
                      </select>
                      <input
                        value={newUser.firstName}
                        onChange={event => setNewUser(current => ({ ...current, firstName: event.target.value }))}
                        placeholder="First name"
                        autoComplete="off"
                        name="new-admin-first-name"
                        className="ux-input"
                        required
                      />
                      <input
                        value={newUser.lastName}
                        onChange={event => setNewUser(current => ({ ...current, lastName: event.target.value }))}
                        placeholder="Last name"
                        autoComplete="off"
                        name="new-admin-last-name"
                        className="ux-input"
                        required
                      />
                      <input
                        type="password"
                        value={newUser.password}
                        onChange={event => setNewUser(current => ({ ...current, password: event.target.value }))}
                        placeholder="New password"
                        autoComplete="new-password"
                        name="new-admin-password"
                        className="ux-input"
                        required
                      />
                      <input
                        type="password"
                        value={newUser.confirmPassword}
                        onChange={event => setNewUser(current => ({ ...current, confirmPassword: event.target.value }))}
                        placeholder="Confirm password"
                        autoComplete="new-password"
                        name="new-admin-confirm-password"
                        className="ux-input"
                        required
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={saving === 'add' || newUser.password !== newUser.confirmPassword} className="ux-button ux-button-primary whitespace-nowrap">
                        {saving === 'add' ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
                        Set
                      </button>
                      <button type="button" onClick={() => setNewUser({ username: '', password: '', confirmPassword: '', firstName: '', lastName: '', role: 'viewer' })} className="ux-button ux-button-secondary min-h-0 px-3 py-2 text-[11px]">
                        Reset
                      </button>
                    </div>
                  </form>
                )}
              </section>

              <section className="ux-card overflow-hidden">
                <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text)]">Users</div>
                <div className="divide-y divide-[var(--border)]">
                  {users.map(user => {
                    const nameOpen = Boolean(expandedNames[user.username])
                    const passwordOpen = Boolean(expandedPasswords[user.username])
                    const nameDraft = nameDrafts[user.username] || { firstName: user.firstName || '', lastName: user.lastName || '' }
                    return (
                    <div key={user.username} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_150px_110px_auto] md:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--text)]">{user.username}</p>
                        <p className="truncate text-[11px] text-[var(--text-subtle)]">{user.displayName || 'Name missing'} · Created {formatTime(user.createdAt) || 'unknown'}</p>
                      </div>
                      <select
                        value={user.role}
                        disabled={saving === user.username}
                        onChange={event => updateUser(user.username, { role: event.target.value })}
                        className="ux-select"
                      >
                        {roles.map(role => <option key={role} value={role}>{role}</option>)}
                      </select>
                      <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                        <input
                          type="checkbox"
                          checked={!user.disabled}
                          disabled={saving === user.username}
                          onChange={event => updateUser(user.username, { disabled: !event.target.checked })}
                        />
                        Active
                      </label>
                      <div className="flex flex-wrap justify-end gap-2">
                        <button type="button" onClick={() => nameOpen ? cancelNameEdit(user.username) : beginNameEdit(user)} className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]">
                          {nameOpen ? 'Close name' : 'Edit name'}
                        </button>
                        <button type="button" onClick={() => passwordOpen ? cancelPasswordEdit(user.username) : beginPasswordEdit(user.username)} className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]">
                          {passwordOpen ? 'Close password' : 'Change password'}
                        </button>
                        <button
                          type="button"
                          disabled={saving === user.username}
                          onClick={() => deleteUser(user.username)}
                          className="ux-icon-button h-9 w-9 text-[var(--danger)]"
                          title="Delete user"
                        >
                          {saving === user.username ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                      </div>
                      </div>
                      {(nameOpen || passwordOpen) && (
                        <div className="mt-3 flex justify-end">
                          {nameOpen && (
                        <div className="grid w-full max-w-xl gap-2 rounded border border-[var(--border)] bg-[var(--surface-1)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
                          <input
                            value={nameDraft.firstName}
                            disabled={saving === user.username}
                            onChange={event => setNameDrafts(current => ({ ...current, [user.username]: { ...nameDraft, firstName: event.target.value } }))}
                            placeholder="First name"
                            className="ux-input min-w-0"
                            required
                          />
                          <input
                            value={nameDraft.lastName}
                            disabled={saving === user.username}
                            onChange={event => setNameDrafts(current => ({ ...current, [user.username]: { ...nameDraft, lastName: event.target.value } }))}
                            placeholder="Last name"
                            className="ux-input min-w-0"
                            required
                          />
                          <button type="button" disabled={saving === user.username || !nameDraft.firstName || !nameDraft.lastName} onClick={() => saveName(user.username)} className="ux-button ux-button-primary min-h-0 px-3 py-2 text-[11px]">
                            Set
                          </button>
                          <button type="button" onClick={() => beginNameEdit(user)} className="ux-button ux-button-secondary min-h-0 px-3 py-2 text-[11px]">
                            Reset
                          </button>
                        </div>
                          )}
                          {passwordOpen && (
                        <div className="grid w-full max-w-xl gap-2 rounded border border-[var(--border)] bg-[var(--surface-1)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
                          <input
                            type="password"
                            value={passwords[user.username]?.password || ''}
                            onChange={event => setPasswords(current => ({ ...current, [user.username]: { ...(current[user.username] || {}), password: event.target.value } }))}
                            placeholder="New password"
                            autoComplete="new-password"
                            className="ux-input min-w-0"
                          />
                          <input
                            type="password"
                            value={passwords[user.username]?.confirm || ''}
                            onChange={event => setPasswords(current => ({ ...current, [user.username]: { ...(current[user.username] || {}), confirm: event.target.value } }))}
                            placeholder="Confirm password"
                            autoComplete="new-password"
                            className="ux-input min-w-0"
                          />
                          <button
                            type="button"
                            disabled={!passwords[user.username]?.password || passwords[user.username]?.password !== passwords[user.username]?.confirm || saving === user.username}
                            onClick={() => resetPassword(user.username)}
                            className="ux-button ux-button-primary min-h-0 px-3 py-2 text-[11px]"
                          >
                            Set
                          </button>
                          <button type="button" onClick={() => beginPasswordEdit(user.username)} className="ux-button ux-button-secondary min-h-0 px-3 py-2 text-[11px]">
                            Reset
                          </button>
                        </div>
                          )}
                        </div>
                      )}
                    </div>
                  )})}
                </div>
              </section>
            </section>

            <section className="ux-card min-h-[520px] overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text)]">
                <Activity size={15} /> Audit Events
              </div>
              <div className="max-h-[calc(100vh-10rem)] divide-y divide-[var(--border)] overflow-y-auto">
                {sortedEvents.length === 0 ? (
                  <p className="px-4 py-8 text-center text-xs text-[var(--text-subtle)]">No audit events yet</p>
                ) : sortedEvents.map(event => (
                  <div key={event.event_id || `${event.timestamp}-${event.action}`} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-[var(--text)]">
                          {event.action} <span className={auditResultClass(event.result)}>{event.result}</span>
                        </p>
                        <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">{eventSummary(event) || 'No additional details'}</p>
                      </div>
                      <span className="shrink-0 text-right text-[10px] text-[var(--text-subtle)]">{formatTime(event.timestamp)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--text-subtle)]">
                      <span>actor: {event.actor || 'system'}</span>
                      {event.ip_hash && <span>ip: {event.ip_hash.slice(0, 10)}</span>}
                      {event.user_agent_hash && <span>agent: {event.user_agent_hash.slice(0, 10)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

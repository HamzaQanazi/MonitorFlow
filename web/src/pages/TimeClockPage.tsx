import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError, getToken } from '../lib/api'
import { useAuth, hasCapability } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import LocationPin from '../components/LocationPin'
import './RequestsPage.css'
import './EmployeesPage.css'
import './TimeClockPage.css'

// Time Clock — manager view. Today (attendance + counters) and Timesheets
// (weekly grid with review/edit/approve/export) share this page and the tab
// strip; each tab owns its own query-param slice of the URL.

// The viewer's own calendar day, not UTC's — toISOString() would hand a
// Gaza manager yesterday's date any time before 03:00 local. The backend
// buckets by COMPANY_TZ; the browser's zone is the closest thing the client
// has to it, and for a manager sitting in the company it is the same zone.
function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtHours(n: number | null, t: (k: string) => string): string {
  return n == null ? '—' : `${Number(n.toFixed(1))}${t('tc_hrs')}`
}

export default function TimeClockPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'timesheets' ? 'timesheets' : 'today'

  function setTab(next: 'today' | 'timesheets') {
    const p = new URLSearchParams(params)
    if (next === 'timesheets') p.set('tab', 'timesheets')
    else p.delete('tab')
    setParams(p, { replace: true })
  }

  return (
    <div className="req">
      <header className="req-head">
        <h1>{t('tc_title')}</h1>
      </header>

      <div className="tc-tabs" role="tablist" aria-label={t('tc_title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'today'}
          className={`tc-tab${tab === 'today' ? ' is-active' : ''}`}
          onClick={() => setTab('today')}
        >
          {t('tc_tab_today')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'timesheets'}
          className={`tc-tab${tab === 'timesheets' ? ' is-active' : ''}`}
          onClick={() => setTab('timesheets')}
        >
          {t('tc_tab_timesheets')}
        </button>
      </div>

      {tab === 'today' ? <TodayView /> : <TimesheetsView />}
    </div>
  )
}

// ---- Today ----

interface LatLng {
  lat: number
  lng: number
}
interface TodayEmployee {
  employeeId: number
  name: string
  shiftId: number | null
  clockInAt: string | null
  clockOutAt: string | null
  clockInLocation: LatLng | null
  clockOutLocation: LatLng | null
  breakStartAt: string | null
  breakEndAt: string | null
  totalHours: number | null
  overtimeHours: number | null
  lateClockIn: boolean
  lateClockOut: boolean
  absent: boolean
  currentlyWorking: boolean
}
interface TodayResponse {
  date: string
  employees: TodayEmployee[]
  counters: {
    lateClockIns: number
    lateClockOuts: number
    attendance: number
    absences: number
    currentlyWorking: number
  }
}

type CounterKey = 'lateClockIns' | 'lateClockOuts' | 'attendance' | 'absences' | 'currentlyWorking'
const COUNTERS: { key: CounterKey; labelKey: string }[] = [
  { key: 'lateClockIns', labelKey: 'tc_counter_late_in' },
  { key: 'lateClockOuts', labelKey: 'tc_counter_late_out' },
  { key: 'attendance', labelKey: 'tc_counter_attendance' },
  { key: 'absences', labelKey: 'tc_counter_absences' },
  { key: 'currentlyWorking', labelKey: 'tc_counter_working' },
]

function matchesCounter(e: TodayEmployee, key: CounterKey): boolean {
  switch (key) {
    case 'lateClockIns':
      return e.lateClockIn
    case 'lateClockOuts':
      return e.lateClockOut
    case 'attendance':
      return e.shiftId != null
    case 'absences':
      return e.absent
    case 'currentlyWorking':
      return e.currentlyWorking
  }
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'
}

function TodayView() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const date = params.get('date') || todayIso()
  const filter = (params.get('filter') as CounterKey | null) ?? null

  const [data, setData] = useState<TodayResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const res = await apiFetch<TodayResponse>(`/timeclock/today?date=${date}`)
    setData(res)
    setError(null)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over `date`, re-run whenever it changes
  }, [date])

  function setDate(d: string) {
    const next = new URLSearchParams(params)
    if (d && d !== todayIso()) next.set('date', d)
    else next.delete('date')
    setParams(next, { replace: true })
  }

  function toggleFilter(key: CounterKey) {
    const next = new URLSearchParams(params)
    if (filter === key) next.delete('filter')
    else next.set('filter', key)
    setParams(next, { replace: true })
  }

  const employees = data?.employees ?? []
  const visible = filter ? employees.filter((e) => matchesCounter(e, filter)) : employees

  return (
    <>
      <div className="req-filters">
        <div className="control-row">
          <label className="date-field">
            <span className="visually-hidden">{t('tc_date_aria')}</span>
            <input type="date" className="req-select" aria-label={t('tc_date_aria')} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
      </div>

      {error ? (
        <div className="req-status">
          <p className="req-status-msg">
            {t('tc_load_err')} {error}
          </p>
          <button
            type="button"
            className="req-retry"
            onClick={() => {
              setError(null)
              load().catch((err: Error) => setError(err.message))
            }}
          >
            {t('try_again')}
          </button>
        </div>
      ) : !data ? (
        <div className="req-skeleton" aria-busy="true">
          <span className="visually-hidden">{t('tc_loading')}</span>
          {Array.from({ length: 6 }, (_, i) => (
            <div className="skel-row" aria-hidden="true" key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="tc-counters" role="group" aria-label={t('tc_title')}>
            {COUNTERS.map((c) => (
              <button
                key={c.key}
                type="button"
                className="tc-counter"
                aria-pressed={filter === c.key}
                onClick={() => toggleFilter(c.key)}
              >
                <span className="tc-counter-num">{data.counters[c.key]}</span>
                <span className="tc-counter-label">{t(c.labelKey)}</span>
              </button>
            ))}
          </div>

          {employees.length === 0 ? (
            <div className="req-empty">
              <h2>{t('tc_none_h')}</h2>
              <p>{t('tc_none_p')}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="req-empty">
              <h2>{t('tc_no_match_h')}</h2>
              {filter && (
                <button type="button" className="req-retry" onClick={() => toggleFilter(filter)}>
                  {t('clear_filters')}
                </button>
              )}
            </div>
          ) : (
            <div className="req-tablewrap">
              <table className="req-table">
                <thead>
                  <tr>
                    <th scope="col">{t('col_name')}</th>
                    <th scope="col">{t('tc_col_clock_in')}</th>
                    <th scope="col">{t('tc_col_clock_out')}</th>
                    <th scope="col">{t('tc_col_break_in')}</th>
                    <th scope="col">{t('tc_col_break_out')}</th>
                    <th scope="col">{t('tc_col_total')}</th>
                    <th scope="col">{t('tc_col_overtime')}</th>
                    <th scope="col">{t('col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => (
                    <tr key={e.employeeId}>
                      <td className="req-service">{e.name}</td>
                      <td className={e.lateClockIn ? 'tc-late' : undefined}>
                        {fmtTime(e.clockInAt)}
                        {e.clockInLocation && (
                          <LocationPin location={e.clockInLocation} title={`${e.name} · ${t('tc_location_clock_in_h')}`} />
                        )}
                      </td>
                      <td className={e.lateClockOut ? 'tc-late' : undefined}>
                        {fmtTime(e.clockOutAt)}
                        {e.clockOutLocation && (
                          <LocationPin location={e.clockOutLocation} title={`${e.name} · ${t('tc_location_clock_out_h')}`} />
                        )}
                      </td>
                      <td>{fmtTime(e.breakStartAt)}</td>
                      <td>{fmtTime(e.breakEndAt)}</td>
                      <td>{fmtHours(e.totalHours, t)}</td>
                      <td>{fmtHours(e.overtimeHours, t)}</td>
                      <td>
                        {e.currentlyWorking ? (
                          <span className="status-pill is-open">
                            <i className="pill-dot" aria-hidden="true" />
                            {t('tc_working_now')}
                          </span>
                        ) : e.absent ? (
                          <span className="status-pill is-closed">
                            <i className="pill-dot" aria-hidden="true" />
                            {t('tc_absent')}
                          </span>
                        ) : e.shiftId == null ? (
                          <span className="tc-muted">{t('tc_not_clocked_in')}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ---- Timesheets ----

interface DayShift {
  id: number
  clockInAt: string
  clockOutAt: string | null
  clockInLocation: LatLng | null
  clockOutLocation: LatLng | null
  approvalStatus: 'pending' | 'approved' | 'edited'
  source: 'clock' | 'manual'
}
interface TimesheetDay {
  totalHours: number
  overtimeHours: number
  unclosed: boolean
  shifts: DayShift[]
}
interface TimesheetRow {
  employeeId: number
  name: string
  days: TimesheetDay[]
  weeklyTotalHours: number
  weeklyOvertimeHours: number
}
interface TimesheetsResponse {
  weekStart: string
  timesheets: TimesheetRow[]
}
type FieldErrors = Record<string, string>

function fieldErrorsOf(err: unknown): FieldErrors {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const errors = (err.body as { errors?: unknown }).errors
    if (errors && typeof errors === 'object') return errors as FieldErrors
  }
  return {}
}

// Sunday on/before `iso`, computed in UTC. The backend itself doesn't force
// a particular week-start day — routes/timeClock.js takes `weekStart` as
// given (see its own GET /timeclock/timesheets comment) — this is purely a
// display choice, matching SchedulePage.tsx's own sundayOf().
function sundayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}
function dayLabel(weekStart: string, i: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
}

function TimesheetsView() {
  const { t } = useI18n()
  const { user } = useAuth()
  // export.csv needs the `export` capability on top of view_all, so a manager
  // without it would otherwise click an enabled button and get a 403. Via
  // hasCapability so the Owner isn't locked out of their own export: the route
  // is requireCapabilityOrAdmin and an admin holds no capabilities (§5).
  const canExport = hasCapability(user, 'export')
  const [params, setParams] = useSearchParams()
  const weekStart = params.get('weekStart') || sundayOf(todayIso())

  const [data, setData] = useState<TimesheetsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  // Separate from the page-load `error` on purpose (same split as ReportsPage):
  // a failed export must not replace the timesheet grid with an error block.
  const [exportError, setExportError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ employeeName: string; dayIndex: number; shifts: DayShift[] } | null>(null)

  async function load() {
    const res = await apiFetch<TimesheetsResponse>(`/timeclock/timesheets?weekStart=${weekStart}`)
    setData(res)
    setError(null)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over `weekStart`, re-run whenever it changes
  }, [weekStart])

  function setWeekStart(d: string) {
    const next = new URLSearchParams(params)
    const sunday = sundayOf(d || todayIso())
    if (sunday !== sundayOf(todayIso())) next.set('weekStart', sunday)
    else next.delete('weekStart')
    setParams(next, { replace: true })
  }

  async function exportCsv() {
    setExporting(true)
    setExportError(null)
    try {
      const res = await fetch(`/api/v1/timeclock/timesheets/export.csv?weekStart=${weekStart}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `timesheets-${weekStart}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError((err as Error).message)
    } finally {
      setExporting(false)
    }
  }

  function onDialogDone() {
    setDialog(null)
    load().catch((err: Error) => setError(err.message))
  }

  const rows = data?.timesheets ?? []

  return (
    <>
      <div className="req-filters">
        <div className="control-row">
          <label className="date-field">
            <span>{t('tc_week_start')}</span>
            <input type="date" className="req-select" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
          </label>
          <button
            type="button"
            className="req-retry emp-add"
            onClick={exportCsv}
            disabled={!canExport || exporting || !data || rows.length === 0}
            title={canExport ? undefined : t('rep_export_no_cap')}
          >
            {exporting ? t('rep_exporting') : t('rep_export')}
          </button>
        </div>
        {exportError && (
          <p className="assign-error" role="alert">
            {t('rep_export_err')} {exportError}
          </p>
        )}
      </div>

      {error ? (
        <div className="req-status">
          <p className="req-status-msg">
            {t('tc_load_err')} {error}
          </p>
          <button
            type="button"
            className="req-retry"
            onClick={() => {
              setError(null)
              load().catch((err: Error) => setError(err.message))
            }}
          >
            {t('try_again')}
          </button>
        </div>
      ) : !data ? (
        <div className="req-skeleton" aria-busy="true">
          <span className="visually-hidden">{t('tc_loading')}</span>
          {Array.from({ length: 6 }, (_, i) => (
            <div className="skel-row" aria-hidden="true" key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="req-empty">
          <h2>{t('tc_none_h')}</h2>
          <p>{t('tc_none_p')}</p>
        </div>
      ) : (
        <div className="req-tablewrap">
          <table className="req-table">
            <thead>
              <tr>
                <th scope="col">{t('col_name')}</th>
                {Array.from({ length: 7 }, (_, i) => (
                  <th scope="col" key={i}>
                    {dayLabel(weekStart, i)}
                  </th>
                ))}
                <th scope="col">{t('tc_col_weekly_total')}</th>
                <th scope="col">{t('tc_col_weekly_overtime')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId}>
                  <td className="req-service">{row.name}</td>
                  {row.days.map((day, i) => {
                    const pending = day.shifts.some((s) => s.approvalStatus === 'pending')
                    return (
                      <td key={i}>
                        {day.shifts.length > 0 ? (
                          <button
                            type="button"
                            className="tc-day-cell"
                            onClick={() => setDialog({ employeeName: row.name, dayIndex: i, shifts: day.shifts })}
                          >
                            {fmtHours(day.totalHours, t)}
                            {/* An unclosed shift's hours are capped at 24h server-side
                                and are a correction to make, not a real total. */}
                            {day.unclosed && <i className="tc-unclosed-dot" aria-hidden="true" title={t('tc_unclosed')} />}
                            {pending && <i className="tc-pending-dot" aria-hidden="true" title={t('tc_status_pending')} />}
                          </button>
                        ) : (
                          <span className="tc-muted">{fmtHours(day.totalHours, t)}</span>
                        )}
                      </td>
                    )
                  })}
                  <td>{fmtHours(row.weeklyTotalHours, t)}</td>
                  <td>{fmtHours(row.weeklyOvertimeHours, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <DayShiftsDialog
          title={`${dialog.employeeName} · ${dayLabel(weekStart, dialog.dayIndex)}`}
          shifts={dialog.shifts}
          onClose={() => setDialog(null)}
          onDone={onDialogDone}
        />
      )}
    </>
  )
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function DayShiftsDialog({
  title,
  shifts,
  onClose,
  onDone,
}: {
  title: string
  shifts: DayShift[]
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useI18n()
  const { user } = useAuth()
  // PATCH /shifts/{id} and /approve both need manage_employees on top of the
  // view_all that got the manager onto this page.
  const canManage = hasCapability(user, 'manage_employees')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [clockInAt, setClockInAt] = useState('')
  const [clockOutAt, setClockOutAt] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function startEdit(shift: DayShift) {
    setEditingId(shift.id)
    setErrors({})
    setClockInAt(toDatetimeLocal(shift.clockInAt))
    setClockOutAt(shift.clockOutAt ? toDatetimeLocal(shift.clockOutAt) : '')
    setNote('')
  }

  async function saveEdit(shiftId: number) {
    setBusyId(shiftId)
    setErrors({})
    try {
      await apiFetch(`/timeclock/shifts/${shiftId}`, {
        method: 'PATCH',
        body: {
          clockInAt: clockInAt ? new Date(clockInAt).toISOString() : '',
          clockOutAt: clockOutAt ? new Date(clockOutAt).toISOString() : '',
          note: note || undefined,
        },
      })
      onDone()
    } catch (err) {
      const fe = fieldErrorsOf(err)
      if (Object.keys(fe).length) setErrors(fe)
      else setErrors({ _: (err as Error).message })
      setBusyId(null)
    }
  }

  async function approve(shiftId: number) {
    setBusyId(shiftId)
    setErrors({})
    try {
      await apiFetch(`/timeclock/shifts/${shiftId}/approve`, { method: 'POST' })
      onDone()
    } catch (err) {
      setErrors({ _: (err as Error).message })
      setBusyId(null)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tc-day-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h4>
          {t('tc_day_shifts_h')} — {title}
        </h4>
        {errors._ && <p className="assign-error">{errors._}</p>}
        <ul className="tc-shift-list">
          {shifts.map((s) => (
            <li key={s.id} className="tc-shift-item">
              {editingId === s.id ? (
                <div className="tc-shift-edit">
                  <label className="field">
                    <span>{t('tc_col_clock_in')}</span>
                    <input type="datetime-local" value={clockInAt} onChange={(e) => setClockInAt(e.target.value)} />
                    {errors.clockInAt && <em className="field-err">{errors.clockInAt}</em>}
                  </label>
                  <label className="field">
                    <span>{t('tc_col_clock_out')}</span>
                    <input type="datetime-local" value={clockOutAt} onChange={(e) => setClockOutAt(e.target.value)} />
                    {errors.clockOutAt && <em className="field-err">{errors.clockOutAt}</em>}
                  </label>
                  <label className="field">
                    <span>{t('tc_field_note')}</span>
                    <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <div className="dialog-actions">
                    <button type="button" className="detail-close-text" onClick={() => setEditingId(null)}>
                      {t('cancel')}
                    </button>
                    <button type="button" className="req-retry" disabled={busyId === s.id} onClick={() => saveEdit(s.id)}>
                      {busyId === s.id ? t('tc_saving') : t('save')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="tc-shift-info">
                    <span>
                      {fmtTime(s.clockInAt)}
                      {s.clockInLocation && (
                        <LocationPin location={s.clockInLocation} title={`${title} · ${t('tc_location_clock_in_h')}`} />
                      )}
                      {' – '}
                      {fmtTime(s.clockOutAt)}
                      {s.clockOutLocation && (
                        <LocationPin location={s.clockOutLocation} title={`${title} · ${t('tc_location_clock_out_h')}`} />
                      )}
                    </span>
                    <span className="tc-muted">{t(s.source === 'manual' ? 'tc_source_manual' : 'tc_source_clock')}</span>
                    <span className={`status-pill is-${s.approvalStatus === 'pending' ? 'closed' : 'open'}`}>
                      <i className="pill-dot" aria-hidden="true" />
                      {t(`tc_status_${s.approvalStatus}`)}
                    </span>
                  </div>
                  <div className="tc-shift-actions">
                    <button
                      type="button"
                      className="action-btn"
                      disabled={!canManage}
                      title={canManage ? undefined : t('no_manage_cap')}
                      onClick={() => startEdit(s)}
                    >
                      {t('emp_edit')}
                    </button>
                    {s.approvalStatus === 'pending' && (
                      <button
                        type="button"
                        className="action-btn"
                        disabled={!canManage || busyId === s.id}
                        title={canManage ? undefined : t('no_manage_cap')}
                        onClick={() => approve(s.id)}
                      >
                        {busyId === s.id ? t('tc_approving') : t('tc_approve')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="req-retry" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError } from '../lib/api'
import { useAuth, hasCapability } from '../auth/AuthContext'
import { useI18n, type Loc } from '../i18n'
import { TranslateButton } from '../components/TranslateButton'
import './RequestsPage.css'
import './EmployeesPage.css'
import './ReportsPage.css'
import './TimeClockPage.css'
import './SchedulePage.css'

// Schedule — manager view. Templates (named shift definitions) and Roster (a
// flat, date-by-date week grid assigning a template to a subtree employee)
// share this page and tab strip, same shape as TimeClockPage's Today/Timesheets.

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
// Monday on/before `iso`, computed in UTC (same convention as TimeClockPage's
// Timesheets tab, matching the backend's UTC day bucketing).
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().slice(0, 10)
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function dayLabel(weekStart: string, i: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
}

type FieldErrors = Record<string, string>
function fieldErrorsOf(err: unknown): FieldErrors {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const errors = (err.body as { errors?: unknown }).errors
    if (errors && typeof errors === 'object') return errors as FieldErrors
  }
  return {}
}

export default function SchedulePage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'templates' ? 'templates' : 'roster'

  function setTab(next: 'roster' | 'templates') {
    const p = new URLSearchParams(params)
    if (next === 'templates') p.set('tab', 'templates')
    else p.delete('tab')
    setParams(p, { replace: true })
  }

  return (
    <div className="req">
      <header className="req-head">
        <h1>{t('sc_title')}</h1>
      </header>

      <div className="tc-tabs" role="tablist" aria-label={t('sc_title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'roster'}
          className={`tc-tab${tab === 'roster' ? ' is-active' : ''}`}
          onClick={() => setTab('roster')}
        >
          {t('sc_tab_roster')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'templates'}
          className={`tc-tab${tab === 'templates' ? ' is-active' : ''}`}
          onClick={() => setTab('templates')}
        >
          {t('sc_tab_templates')}
        </button>
      </div>

      {tab === 'roster' ? <RosterView /> : <TemplatesView />}
    </div>
  )
}

// ---- Templates ----

interface ShiftTemplate {
  id: number
  name: Loc
  startTime: string
  endTime: string
}

function TemplatesView() {
  const { t, L } = useI18n()
  const { user } = useAuth()
  // The page is reachable on view_all, but every write here is
  // requireCapabilityOrAdmin('manage_employees') — without this the buttons
  // are live and 403 on click.
  const canManage = hasCapability(user, 'manage_employees')
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; template: ShiftTemplate } | { kind: 'delete'; template: ShiftTemplate } | null>(null)

  async function load() {
    const res = await apiFetch<{ templates: ShiftTemplate[] }>('/schedule/templates')
    setTemplates(res.templates)
    setError(null)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
  }, [])

  function onDone() {
    setDialog(null)
    load().catch((err: Error) => setError(err.message))
  }

  return (
    <>
      <div className="req-filters">
        <div className="control-row">
          <button
            type="button"
            className="req-retry emp-add"
            onClick={() => setDialog({ kind: 'create' })}
            disabled={!canManage}
            title={canManage ? undefined : t('no_manage_cap')}
          >
            {t('sc_add_template')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="req-status">
          <p className="req-status-msg">
            {t('sc_load_err')} {error}
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
      ) : !templates ? (
        <div className="req-skeleton" aria-busy="true">
          <span className="visually-hidden">{t('sc_loading')}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <div className="skel-row" aria-hidden="true" key={i} />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="req-empty">
          <h2>{t('sc_no_templates_h')}</h2>
          <p>{t('sc_no_templates_p')}</p>
        </div>
      ) : (
        <div className="req-tablewrap">
          <table className="req-table">
            <thead>
              <tr>
                <th scope="col">{t('col_name')}</th>
                <th scope="col">{t('tc_col_clock_in')}</th>
                <th scope="col">{t('tc_col_clock_out')}</th>
                <th scope="col" className="emp-actions-col">
                  {t('col_actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => (
                <tr key={tpl.id}>
                  <td className="req-service">{L(tpl.name)}</td>
                  <td>{tpl.startTime.slice(0, 5)}</td>
                  <td>{tpl.endTime.slice(0, 5)}</td>
                  <td className="emp-actions-col">
                    <div className="emp-actions">
                      <button
                        type="button"
                        className="action-btn"
                        onClick={() => setDialog({ kind: 'edit', template: tpl })}
                        disabled={!canManage}
                        title={canManage ? undefined : t('no_manage_cap')}
                      >
                        {t('emp_edit')}
                      </button>
                      <button
                        type="button"
                        className="action-btn is-danger"
                        onClick={() => setDialog({ kind: 'delete', template: tpl })}
                        disabled={!canManage}
                        title={canManage ? undefined : t('no_manage_cap')}
                      >
                        {t('sc_delete_template')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'create' && <TemplateFormDialog onClose={() => setDialog(null)} onDone={onDone} />}
      {dialog?.kind === 'edit' && <TemplateFormDialog template={dialog.template} onClose={() => setDialog(null)} onDone={onDone} />}
      {dialog?.kind === 'delete' && <DeleteTemplateDialog template={dialog.template} onClose={() => setDialog(null)} onDone={onDone} />}
    </>
  )
}

function TemplateFormDialog({ template, onClose, onDone }: { template?: ShiftTemplate; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n()
  const [nameEn, setNameEn] = useState(template?.name.en ?? '')
  const [nameAr, setNameAr] = useState(template?.name.ar ?? '')
  const [startTime, setStartTime] = useState(template?.startTime.slice(0, 5) ?? '')
  const [endTime, setEndTime] = useState(template?.endTime.slice(0, 5) ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      const body = { name: { en: nameEn, ar: nameAr }, startTime, endTime }
      if (template) await apiFetch(`/schedule/templates/${template.id}`, { method: 'PATCH', body })
      else await apiFetch('/schedule/templates', { method: 'POST', body })
      onDone()
    } catch (err) {
      const fe = fieldErrorsOf(err)
      if (Object.keys(fe).length) setErrors(fe)
      // 409: the hours are frozen because the shift has already been worked.
      else if (err instanceof ApiError && err.status === 409) setErrors({ _: t('sc_template_hours_locked') })
      else setErrors({ _: (err as Error).message })
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h4>{template ? t('sc_edit_template_h') : t('sc_add_template')}</h4>
        {errors._ && <p className="assign-error">{errors._}</p>}
        <form onSubmit={submit}>
          <label className="field">
            <span>{t('sc_field_name_en')}</span>
            <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} required />
            {errors.name && <em className="field-err">{errors.name}</em>}
          </label>
          <label className="field">
            <span>{t('sc_field_name_ar')}</span>
            <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" required />
          </label>
          <TranslateButton en={nameEn} ar={nameAr} setEn={setNameEn} setAr={setNameAr} />
          <label className="field">
            <span>{t('sc_field_start')}</span>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
            {errors.startTime && <em className="field-err">{errors.startTime}</em>}
          </label>
          <label className="field">
            <span>{t('sc_field_end')}</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
            {errors.endTime && <em className="field-err">{errors.endTime}</em>}
          </label>
          <div className="dialog-actions">
            <button type="button" className="detail-close-text" onClick={onClose}>
              {t('cancel')}
            </button>
            <button type="submit" className="req-retry" disabled={busy}>
              {busy ? t('tc_saving') : t('save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DeleteTemplateDialog({ template, onClose, onDone }: { template: ShiftTemplate; onClose: () => void; onDone: () => void }) {
  const { t, L } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/schedule/templates/${template.id}`, { method: 'DELETE' })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? t('sc_template_in_use') : (err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h4>
          {t('sc_delete_template_q_pre')} {L(template.name)}?
        </h4>
        {error && <p className="assign-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="detail-close-text" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="button" className="req-retry is-danger" onClick={confirm} disabled={busy}>
            {t('sc_delete_template')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Roster ----

interface RosterEntry {
  date: string
  templateId: number
  templateName: Loc
  startTime: string
  endTime: string
}
interface RosterEmployee {
  employeeId: number
  name: string
  entries: RosterEntry[]
}

function RosterView() {
  const { t, L } = useI18n()
  const { user } = useAuth()
  // Reading the roster is view_all; PUT /roster and POST /suggest both need
  // manage_employees (see TemplatesView).
  const canManage = hasCapability(user, 'manage_employees')
  const [params, setParams] = useSearchParams()
  const weekStart = params.get('weekStart') || mondayOf(todayIso())
  const weekEnd = addDays(weekStart, 6)

  const [employees, setEmployees] = useState<RosterEmployee[] | null>(null)
  const [templates, setTemplates] = useState<ShiftTemplate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cell, setCell] = useState<{ employeeId: number; employeeName: string; date: string; current: RosterEntry | undefined } | null>(null)
  const [copying, setCopying] = useState(false)
  const [copyConfirm, setCopyConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)

  async function load() {
    const [rosterRes, templatesRes] = await Promise.all([
      apiFetch<{ employees: RosterEmployee[] }>(`/schedule/roster?from=${weekStart}&to=${weekEnd}`),
      apiFetch<{ templates: ShiftTemplate[] }>('/schedule/templates'),
    ])
    setEmployees(rosterRes.employees)
    setTemplates(templatesRes.templates)
    setError(null)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over `weekStart`, re-run whenever it changes
  }, [weekStart])

  function setWeekStart(d: string) {
    const next = new URLSearchParams(params)
    const monday = mondayOf(d || todayIso())
    if (monday !== mondayOf(todayIso())) next.set('weekStart', monday)
    else next.delete('weekStart')
    setParams(next, { replace: true })
  }

  function onCellDone() {
    setCell(null)
    load().catch((err: Error) => setError(err.message))
  }

  async function copyLastWeek() {
    setCopyConfirm(false)
    setCopying(true)
    try {
      const prevStart = addDays(weekStart, -7)
      const prevEnd = addDays(prevStart, 6)
      const prev = await apiFetch<{ employees: RosterEmployee[] }>(`/schedule/roster?from=${prevStart}&to=${prevEnd}`)
      const entries = prev.employees.flatMap((emp) =>
        emp.entries.map((e) => ({ employeeId: emp.employeeId, date: addDays(e.date, 7), templateId: e.templateId })),
      )
      if (entries.length) await apiFetch('/schedule/roster', { method: 'PUT', body: { entries } })
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCopying(false)
    }
  }

  async function clearWeek() {
    setClearConfirm(false)
    setClearing(true)
    try {
      const entries = rows.flatMap((emp) => emp.entries.map((e) => ({ employeeId: emp.employeeId, date: e.date, templateId: null })))
      if (entries.length) await apiFetch('/schedule/roster', { method: 'PUT', body: { entries } })
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setClearing(false)
    }
  }

  const rows = employees ?? []

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
            onClick={() => setCopyConfirm(true)}
            disabled={!canManage || copying || !employees}
            title={canManage ? undefined : t('no_manage_cap')}
          >
            {copying ? t('sc_copying') : t('sc_copy_last_week')}
          </button>
          <button
            type="button"
            className="req-retry emp-add"
            onClick={() => setClearConfirm(true)}
            disabled={!canManage || clearing || !employees || !rows.some((emp) => emp.entries.length)}
            title={canManage ? undefined : t('no_manage_cap')}
          >
            {clearing ? t('sc_clearing') : t('sc_clear_week')}
          </button>
          <button
            type="button"
            className="req-retry emp-add"
            onClick={() => setSuggestOpen(true)}
            disabled={!canManage || !employees}
            title={canManage ? undefined : t('no_manage_cap')}
          >
            {t('sc_suggest')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="req-status">
          <p className="req-status-msg">
            {t('sc_load_err')} {error}
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
      ) : !employees ? (
        <div className="req-skeleton" aria-busy="true">
          <span className="visually-hidden">{t('sc_loading')}</span>
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
          <table className="req-table sc-roster-table">
            <thead>
              <tr>
                <th scope="col">{t('col_name')}</th>
                {Array.from({ length: 7 }, (_, i) => (
                  <th scope="col" key={i}>
                    {dayLabel(weekStart, i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((emp) => (
                <tr key={emp.employeeId}>
                  <td className="req-service">{emp.name}</td>
                  {Array.from({ length: 7 }, (_, i) => {
                    const date = addDays(weekStart, i)
                    const entry = emp.entries.find((e) => e.date === date)
                    return (
                      <td key={i}>
                        <button
                          type="button"
                          className="tc-day-cell"
                          onClick={() => setCell({ employeeId: emp.employeeId, employeeName: emp.name, date, current: entry })}
                        >
                          {entry ? L(entry.templateName) : <span className="tc-muted">{t('sc_off')}</span>}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cell && (
        <RosterCellDialog
          title={`${cell.employeeName} · ${dayLabel(weekStart, (new Date(`${cell.date}T00:00:00Z`).getTime() - new Date(`${weekStart}T00:00:00Z`).getTime()) / 86400000)}`}
          employeeId={cell.employeeId}
          date={cell.date}
          current={cell.current}
          templates={templates}
          onClose={() => setCell(null)}
          onDone={onCellDone}
        />
      )}

      {suggestOpen && (
        <SuggestDialog
          weekStart={weekStart}
          weekEnd={weekEnd}
          templates={templates}
          onClose={() => setSuggestOpen(false)}
          onDone={() => {
            setSuggestOpen(false)
            load().catch((err: Error) => setError(err.message))
          }}
        />
      )}

      {copyConfirm && (
        <div className="dialog-backdrop" onClick={() => setCopyConfirm(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h4>{t('sc_copy_last_week_q')}</h4>
            <p className="req-status-msg">{t('sc_copy_last_week_warn')}</p>
            <div className="dialog-actions">
              <button type="button" className="detail-close-text" onClick={() => setCopyConfirm(false)}>
                {t('cancel')}
              </button>
              <button type="button" className="req-retry" onClick={copyLastWeek}>
                {t('sc_copy_last_week')}
              </button>
            </div>
          </div>
        </div>
      )}

      {clearConfirm && (
        <div className="dialog-backdrop" onClick={() => setClearConfirm(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h4>{t('sc_clear_week_q')}</h4>
            <p className="req-status-msg">{t('sc_clear_week_warn')}</p>
            <div className="dialog-actions">
              <button type="button" className="detail-close-text" onClick={() => setClearConfirm(false)}>
                {t('cancel')}
              </button>
              <button type="button" className="req-retry" onClick={clearWeek}>
                {t('sc_clear_week')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function RosterCellDialog({
  title,
  employeeId,
  date,
  current,
  templates,
  onClose,
  onDone,
}: {
  title: string
  employeeId: number
  date: string
  current: RosterEntry | undefined
  templates: ShiftTemplate[]
  onClose: () => void
  onDone: () => void
}) {
  const { t, L } = useI18n()
  const { user } = useAuth()
  const canManage = hasCapability(user, 'manage_employees')
  const [templateId, setTemplateId] = useState<string>(current ? String(current.templateId) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(clear: boolean) {
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/schedule/roster', {
        method: 'PUT',
        body: { entries: [{ employeeId, date, templateId: clear ? null : Number(templateId) }] },
      })
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h4>{title}</h4>
        {error && <p className="assign-error">{error}</p>}
        <label className="field">
          <span>{t('sc_field_template')}</span>
          <select className="req-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="" disabled>
              {t('sc_pick_template')}
            </option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {L(tpl.name)} ({tpl.startTime.slice(0, 5)}–{tpl.endTime.slice(0, 5)})
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          {current && (
            <button
              type="button"
              className="action-btn is-danger"
              disabled={!canManage || busy}
              title={canManage ? undefined : t('no_manage_cap')}
              onClick={() => save(true)}
            >
              {t('sc_clear_day')}
            </button>
          )}
          <button type="button" className="detail-close-text" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="req-retry"
            disabled={!canManage || busy || !templateId}
            title={canManage ? undefined : t('no_manage_cap')}
            onClick={() => save(false)}
          >
            {busy ? t('tc_saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// AI Suggest — generates a preview via POST /schedule/suggest (a local
// fairness heuristic, no vendor call — CLAUDE.md §13) and only ever writes
// through the same PUT /schedule/roster a manual edit uses, once the manager
// reviews and applies it. Employee-subset picking isn't exposed here yet
// (the API already supports it via employeeIds) — add a picker if "whole
// subtree" stops being the common case.
const WEEKDAYS: { value: number; key: string }[] = [
  { value: 1, key: 'day_mon' },
  { value: 2, key: 'day_tue' },
  { value: 3, key: 'day_wed' },
  { value: 4, key: 'day_thu' },
  { value: 5, key: 'day_fri' },
  { value: 6, key: 'day_sat' },
  { value: 0, key: 'day_sun' },
]

interface SuggestEntry {
  employeeId: number
  employeeName: string
  date: string
  templateId: number
}

function SuggestDialog({
  weekStart,
  weekEnd,
  templates,
  onClose,
  onDone,
}: {
  weekStart: string
  weekEnd: string
  templates: ShiftTemplate[]
  onClose: () => void
  onDone: () => void
}) {
  const { t, L } = useI18n()
  const [from, setFrom] = useState(weekStart)
  const [to, setTo] = useState(weekEnd)
  const [templateId, setTemplateId] = useState(templates[0] ? String(templates[0].id) : '')
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4])) // Fri+Sat off by default
  const [perDay, setPerDay] = useState('')
  const [preview, setPreview] = useState<{ entries: SuggestEntry[]; alreadyScheduledSkipped: number; restDaySkipped: number } | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleDay(d: number) {
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      const body: Record<string, unknown> = { from, to, templateId: Number(templateId), weekdays: Array.from(days) }
      if (perDay.trim()) body.perDay = Number(perDay)
      const res = await apiFetch<{ entries: SuggestEntry[]; alreadyScheduledSkipped: number; restDaySkipped: number }>('/schedule/suggest', {
        method: 'POST',
        body,
      })
      setPreview(res)
    } catch (err) {
      const fe = fieldErrorsOf(err)
      if (Object.keys(fe).length) setErrors(fe)
      else setErrors({ _: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!preview) return
    setBusy(true)
    setErrors({})
    try {
      await apiFetch('/schedule/roster', {
        method: 'PUT',
        body: { entries: preview.entries.map((e) => ({ employeeId: e.employeeId, date: e.date, templateId: e.templateId })) },
      })
      onDone()
    } catch (err) {
      setErrors({ _: (err as Error).message })
      setBusy(false)
    }
  }

  const distinctEmployees = preview ? new Set(preview.entries.map((e) => e.employeeId)).size : 0

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h4>{preview ? t('sc_suggest_preview_h') : t('sc_suggest_h')}</h4>
        {errors._ && <p className="assign-error">{errors._}</p>}

        {!preview ? (
          <form onSubmit={generate}>
            <label className="field">
              <span>{t('sc_suggest_from')}</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              {errors.from && <em className="field-err">{errors.from}</em>}
            </label>
            <label className="field">
              <span>{t('sc_suggest_to')}</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
              {errors.to && <em className="field-err">{errors.to}</em>}
            </label>
            <label className="field">
              <span>{t('sc_suggest_template')}</span>
              <select className="req-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
                <option value="" disabled>
                  {t('sc_pick_template')}
                </option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {L(tpl.name)} ({tpl.startTime.slice(0, 5)}–{tpl.endTime.slice(0, 5)})
                  </option>
                ))}
              </select>
              {errors.templateId && <em className="field-err">{errors.templateId}</em>}
            </label>
            <fieldset className="field">
              <legend>{t('sc_suggest_days')}</legend>
              <div className="control-row">
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="check-field">
                    <input type="checkbox" checked={days.has(d.value)} onChange={() => toggleDay(d.value)} />
                    <span>{t(d.key)}</span>
                  </label>
                ))}
              </div>
              {errors.weekdays && <em className="field-err">{errors.weekdays}</em>}
            </fieldset>
            <label className="field">
              <span>{t('sc_suggest_per_day')}</span>
              <input type="number" min={1} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
              <em className="field-hint">{t('sc_suggest_per_day_hint')}</em>
              {errors.perDay && <em className="field-err">{errors.perDay}</em>}
            </label>
            <div className="dialog-actions">
              <button type="button" className="detail-close-text" onClick={onClose}>
                {t('cancel')}
              </button>
              <button type="submit" className="req-retry" disabled={busy || !templateId || !days.size}>
                {busy ? t('sc_suggest_generating') : t('sc_suggest_generate')}
              </button>
            </div>
          </form>
        ) : preview.entries.length === 0 ? (
          <>
            <p className="req-status-msg">{t('sc_suggest_empty')}</p>
            <div className="dialog-actions">
              <button type="button" className="detail-close-text" onClick={() => setPreview(null)}>
                {t('sc_suggest_back')}
              </button>
              <button type="button" className="req-retry" onClick={onClose}>
                {t('cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="req-status-msg">
              {preview.entries.length} {t('sc_suggest_count')} {distinctEmployees} {t('sc_suggest_employees')}
              {preview.alreadyScheduledSkipped > 0 && (
                <>
                  {' · '}
                  {preview.alreadyScheduledSkipped} {t('sc_suggest_skipped')}
                </>
              )}
              {preview.restDaySkipped > 0 && (
                <>
                  {' · '}
                  {preview.restDaySkipped} {t('sc_suggest_rest_day_skipped')}
                </>
              )}
            </p>
            <ul className="sc-suggest-list">
              {preview.entries.map((e, i) => (
                <li key={i}>
                  {e.date} — {e.employeeName}
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="detail-close-text" onClick={() => setPreview(null)} disabled={busy}>
                {t('sc_suggest_back')}
              </button>
              <button type="button" className="req-retry" onClick={apply} disabled={busy}>
                {busy ? t('sc_suggest_applying') : t('sc_suggest_apply')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

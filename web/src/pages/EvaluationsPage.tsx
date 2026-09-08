import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useAuth, hasCapability } from '../auth/AuthContext'
import { useI18n, type Loc } from '../i18n'
import { formatDuration } from '../lib/format'
import './RequestsPage.css'
import './EmployeesPage.css'
import './EvaluationsPage.css'

// Employee evaluation system (CLAUDE.md §13, supervisor-mandated). A manager
// picks a date range and generates scored evaluations — backend blends the
// same I10-safe outcome metrics used elsewhere (reopen rate, SLA breach
// rate, avg resolution, completed count) against each employee's own
// department peers. No cron, no auto-generation — every evaluation here is a
// deliberate action. Two modes:
//   - single: one employee's full history over time.
//   - compare: a leaderboard (latest evaluation per employee) across one
//     department, or the actor's whole reachable scope — which is just
//     "their department" for a plain manager, or "the whole company" for an
//     admin/view_all_company holder. No separate "generate all" permission
//     check needed: the backend collapses this the same way Gate 2 already
//     does everywhere else.

interface EmployeeOption {
  id: number
  name: string
  departmentId: number
  departmentName: Loc
}
interface Department {
  id: number
  name: Loc
}
interface EvaluationBreakdown {
  poolSize: number
  // 'department': scored against active department peers (the usual case).
  // 'self': no active peers, so scored against this employee's own
  // immediately preceding period instead — a different department's work
  // isn't a fair comparison.
  comparedTo: 'department' | 'self'
  metrics: {
    reopenRate: number | null
    slaBreachRate: number | null
    avgResolutionMinutes: number | null
    completedCount: number
    openCount: number
  }
}
interface Evaluation {
  id: number
  employeeId: number
  periodStart: string
  periodEnd: string
  score: number
  breakdown: EvaluationBreakdown
  generatedByName: string
  generatedAt: string
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}
function monthAgoIso() {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 10)
}
function scoreClass(score: number): string {
  if (score >= 70) return 'is-active'
  if (score >= 40) return ''
  return 'is-inactive'
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

// Shared by both modes: a table of evaluations, each row expandable into its
// metric breakdown. `employeeLabel` resolves an id to a display name (and,
// in compare mode, its department) — single mode passes null since every row
// is already the one chosen employee.
function EvaluationTable({
  evaluations,
  employeeLabel,
}: {
  evaluations: Evaluation[]
  employeeLabel: ((employeeId: number) => { name: string; department: string | null }) | null
}) {
  const { t } = useI18n()
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const colCount = employeeLabel ? 6 : 5

  return (
    <div className="req-tablewrap">
      <table className="req-table">
        <thead>
          <tr>
            {employeeLabel && <th scope="col">{t('col_name')}</th>}
            <th scope="col">{t('col_period')}</th>
            <th scope="col">{t('col_score')}</th>
            <th scope="col">{t('col_generated_by')}</th>
            <th scope="col">{t('col_generated_at')}</th>
            <th scope="col" className="emp-actions-col">
              {t('col_actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {evaluations.map((ev) => {
            const who = employeeLabel?.(ev.employeeId)
            return (
              <Fragment key={ev.id}>
                <tr>
                  {employeeLabel && (
                    <td>
                      {who?.name ?? ev.employeeId}
                      {who?.department && <span className="emp-branch"> · {who.department}</span>}
                    </td>
                  )}
                  <td>
                    {ev.periodStart} – {ev.periodEnd}
                  </td>
                  <td>
                    <span className={`emp-badge${scoreClass(ev.score) ? ` ${scoreClass(ev.score)}` : ''}`}>
                      {ev.score}
                    </span>
                  </td>
                  <td>{ev.generatedByName}</td>
                  <td>{new Date(ev.generatedAt).toLocaleString()}</td>
                  <td className="emp-actions">
                    <button
                      type="button"
                      className="action-btn"
                      onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                    >
                      {expandedId === ev.id ? t('eval_hide_breakdown') : t('eval_view_breakdown')}
                    </button>
                  </td>
                </tr>
                {expandedId === ev.id && (
                  <tr>
                    <td colSpan={colCount}>
                      <div className="emp-summary-tablewrap">
                        <h3>{t('eval_breakdown_h')}</h3>
                        <p className="req-meta">
                          {ev.breakdown.comparedTo === 'self'
                            ? t('eval_breakdown_pool_self')
                            : `${t('eval_breakdown_pool_before')}${ev.breakdown.poolSize} ${t('eval_breakdown_pool_after')}`}
                        </p>
                        <table className="req-table">
                          <thead>
                            <tr>
                              <th scope="col"></th>
                              <th scope="col">{t('col_score')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>{t('eval_metric_reopen')}</td>
                              <td>{pct(ev.breakdown.metrics.reopenRate)}</td>
                            </tr>
                            <tr>
                              <td>{t('eval_metric_sla')}</td>
                              <td>{pct(ev.breakdown.metrics.slaBreachRate)}</td>
                            </tr>
                            <tr>
                              <td>{t('eval_metric_resolution')}</td>
                              <td>{formatDuration(ev.breakdown.metrics.avgResolutionMinutes, t)}</td>
                            </tr>
                            <tr>
                              <td>{t('eval_metric_completed')}</td>
                              <td>{ev.breakdown.metrics.completedCount}</td>
                            </tr>
                            <tr>
                              <td>{t('eval_metric_open')}</td>
                              <td>{ev.breakdown.metrics.openCount}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function EvaluationsPage() {
  const { t, L } = useI18n()
  const { user } = useAuth()
  // Whether this account can reach more than one department (admin, or a
  // level holding view_all_company) — only then does a department picker for
  // "compare" mode make sense; a plain manager's scope is just their own.
  const companyWide = user?.role === 'admin' || hasCapability(user, 'view_all_company')

  const [mode, setMode] = useState<'single' | 'compare'>('single')
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [periodStart, setPeriodStart] = useState(monthAgoIso())
  const [periodEnd, setPeriodEnd] = useState(todayIso())
  const [generating, setGenerating] = useState(false)
  const [genErrors, setGenErrors] = useState<Record<string, string>>({})

  const [evaluations, setEvaluations] = useState<Evaluation[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ employees: EmployeeOption[] }>('/employees?pageSize=100')
      .then((res) => setEmployees(res.employees))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!companyWide) return
    apiFetch<{ departments: Department[] }>('/departments')
      .then((res) => setDepartments(res.departments))
      .catch(() => {})
  }, [companyWide])

  const employeeLabel = useCallback(
    (id: number) => {
      const e = employees.find((emp) => emp.id === id)
      return { name: e?.name ?? String(id), department: e ? L(e.departmentName) : null }
    },
    [employees, L],
  )

  const load = useCallback(async () => {
    if (mode === 'single') {
      if (!employeeId) {
        setEvaluations(null)
        return
      }
      const res = await apiFetch<{ evaluations: Evaluation[] }>(`/evaluations?employeeId=${employeeId}`)
      setEvaluations(res.evaluations)
      setError(null)
      return
    }
    const qs = departmentId ? `?departmentId=${departmentId}` : ''
    const res = await apiFetch<{ evaluations: Evaluation[] }>(`/evaluations${qs}`)
    setEvaluations(res.evaluations)
    setError(null)
  }, [mode, employeeId, departmentId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
  }, [load])

  async function generate() {
    setGenErrors({})
    if (mode === 'single' && !employeeId) return
    setGenerating(true)
    try {
      const body: Record<string, unknown> = { periodStart, periodEnd }
      if (mode === 'single') body.employeeId = Number(employeeId)
      else if (departmentId) body.departmentId = Number(departmentId)
      await apiFetch('/evaluations/generate', { method: 'POST', body })
      await load()
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'errors' in err.body) {
        setGenErrors((err.body as { errors: Record<string, string> }).errors)
      } else {
        setError((err as Error).message)
      }
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="req">
      <header className="req-head">
        <h1>{t('eval_title')}</h1>
      </header>

      <div className="req-filters">
        <div className="control-row">
          <div className="req-tabs" role="tablist" aria-label={t('eval_mode_label')}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'single'}
              className={`req-tab${mode === 'single' ? ' is-active' : ''}`}
              onClick={() => setMode('single')}
            >
              {t('eval_mode_single')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'compare'}
              className={`req-tab${mode === 'compare' ? ' is-active' : ''}`}
              onClick={() => setMode('compare')}
            >
              {t('eval_mode_compare')}
            </button>
          </div>
        </div>
        <div className="control-row">
          {mode === 'single' ? (
            <select
              className="req-select"
              aria-label={t('eval_employee_label')}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">{t('eval_employee_ph')}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          ) : (
            companyWide && (
              <select
                className="req-select"
                aria-label={t('eval_department_label')}
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                <option value="">{t('eval_department_all')}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {L(d.name)}
                  </option>
                ))}
              </select>
            )
          )}
          <input
            type="date"
            className="req-select"
            aria-label={t('eval_period_start')}
            value={periodStart}
            max={periodEnd}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
          <input
            type="date"
            className="req-select"
            aria-label={t('eval_period_end')}
            value={periodEnd}
            min={periodStart}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
          <button
            type="button"
            className="req-retry emp-add"
            disabled={(mode === 'single' && !employeeId) || generating}
            onClick={generate}
          >
            {generating ? t('eval_generating') : t('eval_generate')}
          </button>
        </div>
        {(genErrors.periodStart || genErrors.periodEnd || genErrors.employeeId || genErrors.departmentId) && (
          <p className="req-status-msg">
            {genErrors.periodStart || genErrors.periodEnd || genErrors.employeeId || genErrors.departmentId}
          </p>
        )}
      </div>

      {mode === 'single' && !employeeId ? (
        <div className="req-empty">
          <h2>{t('eval_pick_employee_h')}</h2>
          <p>{t('eval_pick_employee_p')}</p>
        </div>
      ) : error ? (
        <div className="req-status">
          <p className="req-status-msg">
            {t('eval_load_err')} {error}
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
      ) : !evaluations ? (
        <div className="req-skeleton" aria-busy="true">
          <span className="visually-hidden">{t('eval_loading')}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <div className="skel-row" aria-hidden="true" key={i} />
          ))}
        </div>
      ) : evaluations.length === 0 ? (
        <div className="req-empty">
          <h2>{t('eval_none_h')}</h2>
          <p>{t('eval_none_p')}</p>
        </div>
      ) : (
        <EvaluationTable evaluations={evaluations} employeeLabel={mode === 'compare' ? employeeLabel : null} />
      )}
    </div>
  )
}

import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useI18n, type Loc } from '../i18n'
import { formatDuration } from '../lib/format'
import './RequestsPage.css'
import './EmployeesPage.css'

// Employee evaluation system (CLAUDE.md §13, supervisor-mandated). A manager
// picks one employee + a date range and generates a scored evaluation —
// backend blends the same I10-safe outcome metrics used elsewhere (reopen
// rate, SLA breach rate, avg resolution, completed count) against the
// employee's own department peers. No cron, no auto-generation — every
// evaluation here is a deliberate action.

interface EmployeeOption {
  id: number
  name: string
  departmentName: Loc
}
interface EvaluationBreakdown {
  weights: { reopen: number; slaBreach: number; resolution: number; completed: number }
  poolSize: number
  metrics: {
    reopenRate: number | null
    slaBreachRate: number | null
    avgResolutionMinutes: number | null
    completedCount: number
    openCount: number
  }
  goodness: { reopen: number; slaBreach: number; resolution: number; completed: number }
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

export default function EvaluationsPage() {
  const { t } = useI18n()
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [periodStart, setPeriodStart] = useState(monthAgoIso())
  const [periodEnd, setPeriodEnd] = useState(todayIso())
  const [generating, setGenerating] = useState(false)
  const [genErrors, setGenErrors] = useState<Record<string, string>>({})

  const [evaluations, setEvaluations] = useState<Evaluation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    apiFetch<{ employees: EmployeeOption[] }>('/employees?pageSize=100')
      .then((res) => setEmployees(res.employees))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!employeeId) {
      setEvaluations(null)
      return
    }
    const res = await apiFetch<{ evaluations: Evaluation[] }>(`/evaluations?employeeId=${employeeId}`)
    setEvaluations(res.evaluations)
    setError(null)
  }, [employeeId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setError fires only in the async catch, not synchronously
    load().catch((err: Error) => setError(err.message))
  }, [load])

  async function generate() {
    setGenErrors({})
    if (!employeeId) return
    setGenerating(true)
    try {
      await apiFetch('/evaluations/generate', {
        method: 'POST',
        body: { employeeId: Number(employeeId), periodStart, periodEnd },
      })
      setExpandedId(null)
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
          <select
            className="req-select"
            aria-label={t('eval_employee_label')}
            value={employeeId}
            onChange={(e) => {
              setEmployeeId(e.target.value)
              setExpandedId(null)
            }}
          >
            <option value="">{t('eval_employee_ph')}</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
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
          <button type="button" className="req-retry emp-add" disabled={!employeeId || generating} onClick={generate}>
            {generating ? t('eval_generating') : t('eval_generate')}
          </button>
        </div>
        {(genErrors.periodStart || genErrors.periodEnd || genErrors.employeeId) && (
          <p className="req-status-msg">{genErrors.periodStart || genErrors.periodEnd || genErrors.employeeId}</p>
        )}
      </div>

      {!employeeId ? (
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
        <div className="req-tablewrap">
          <table className="req-table">
            <thead>
              <tr>
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
              {evaluations.map((ev) => (
                <Fragment key={ev.id}>
                  <tr>
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
                      <td colSpan={5}>
                        <div className="emp-summary-tablewrap">
                          <h3>{t('eval_breakdown_h')}</h3>
                          <p className="req-meta">
                            {t('eval_breakdown_pool_before')}
                            {ev.breakdown.poolSize}
                            {' '}
                            {t('eval_breakdown_pool_after')}
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

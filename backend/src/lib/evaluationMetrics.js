// Employee evaluation scoring (CLAUDE.md §13, supervisor-mandated). Blends
// the same I10-safe outcome metrics autoAssign.js/dashboard.js already use —
// reopen rate, avg resolution minutes, SLA breach rate, completed count —
// into one 0-100 score for a manager-picked date range. Never a live or
// behavioural metric (no location, no idle time, nothing "what are they
// doing right now" — I10).
//
// Scored relative to the target employee's own department peers over the
// same period, not fixed thresholds — the same "normalize across a
// comparison pool" approach autoAssign.js uses to rank assignment
// candidates, just scoring one already-chosen employee against their peers
// instead of picking one from a pool. A department of one just neutrals out
// (normalize()'s <2-points rule), same as a brand-new hire does in
// auto-assign.
const pool = require('../db');
const { normalize } = require('./scoring');

// completed count is "higher is better"; the other three are "lower is
// better" — WEIGHTS apply to a per-axis 0..1 "goodness" already oriented so
// higher always means better, see scoreEmployee below.
const WEIGHTS = { reopen: 0.35, slaBreach: 0.25, resolution: 0.25, completed: 0.15 };

// Per-employee outcome metrics for every id in `employeeIds`, windowed to
// [periodStart, periodEnd). open_count is deliberately NOT period-bound —
// "current open workload" is a snapshot metric everywhere else it's used
// (autoAssign.js, EmployeesPage), not a historical one.
async function loadMetrics(employeeIds, periodStart, periodEnd) {
  const { rows } = await pool.query(
    `SELECT u.id AS employee_id, u.name AS employee_name,
            -- Completed count + avg resolution minutes: same "resolved"
            -- definition as the CSV export / EmployeesPage / autoAssign.js
            -- (request creation to the completion-form transition's target
            -- status), windowed to completions that landed in this period.
            (SELECT COUNT(*)::int
             FROM task t
             JOIN request r ON r.id = t.request_id
             JOIN workflow_definition w ON w.service_type_id = r.service_type_id
             CROSS JOIN LATERAL (
               SELECT MIN(h.changed_at) AS completed_at
               FROM request_status_history h
               WHERE h.request_id = r.id
                 AND h.status = (
                   SELECT tr->>'to' FROM jsonb_array_elements(w.transitions) tr
                   WHERE tr->>'required_form_key' IS NOT NULL
                   LIMIT 1
                 )
             ) comp
             WHERE t.employee_id = u.id
               AND comp.completed_at >= $2 AND comp.completed_at < $3
            ) AS completed_count,
            (SELECT AVG(EXTRACT(EPOCH FROM (comp.completed_at - r.created_at)) / 60)
             FROM task t
             JOIN request r ON r.id = t.request_id
             JOIN workflow_definition w ON w.service_type_id = r.service_type_id
             CROSS JOIN LATERAL (
               SELECT MIN(h.changed_at) AS completed_at
               FROM request_status_history h
               WHERE h.request_id = r.id
                 AND h.status = (
                   SELECT tr->>'to' FROM jsonb_array_elements(w.transitions) tr
                   WHERE tr->>'required_form_key' IS NOT NULL
                   LIMIT 1
                 )
             ) comp
             WHERE t.employee_id = u.id
               AND comp.completed_at >= $2 AND comp.completed_at < $3
            ) AS avg_resolution_minutes,
            -- Reopen rate: identical shape to autoAssign.js's per-employee
            -- version (terminal->non-terminal LAG over the full request
            -- history, so a reopen right at the period edge is still
            -- detected), just counting only the terminal/reopen events that
            -- landed inside this period.
            (SELECT CASE WHEN COUNT(*) FILTER (WHERE hist.is_terminal AND hist.changed_at >= $2 AND hist.changed_at < $3) = 0 THEN NULL
                    ELSE COUNT(*) FILTER (WHERE hist.prev_terminal AND NOT hist.is_terminal AND hist.changed_at >= $2 AND hist.changed_at < $3)::float
                         / COUNT(*) FILTER (WHERE hist.is_terminal AND hist.changed_at >= $2 AND hist.changed_at < $3) END
             FROM (
               SELECT h.request_id, h.changed_at, (s->>'is_terminal')::bool AS is_terminal,
                      LAG((s->>'is_terminal')::bool) OVER (PARTITION BY h.request_id ORDER BY h.changed_at) AS prev_terminal
               FROM request_status_history h
               JOIN task t ON t.request_id = h.request_id
               JOIN request r ON r.id = h.request_id
               JOIN workflow_definition w ON w.service_type_id = r.service_type_id
               JOIN LATERAL jsonb_array_elements(w.statuses) s ON s->>'key' = h.status
               WHERE t.employee_id = u.id
             ) hist
            ) AS reopen_rate,
            -- SLA breach rate: how much of the time this employee's requests
            -- spent in a status with an sla_minutes budget, during this
            -- period, ran past that budget. Dwell time per status = until the
            -- next status change, or now() if it's still the current one
            -- (same sla_minutes concept escalation.js/dashboard.js use, just
            -- measured historically instead of "is it breaching right now").
            (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                    ELSE COUNT(*) FILTER (WHERE dwell.spent > dwell.sla_minutes * INTERVAL '1 minute')::float / COUNT(*) END
             FROM (
               SELECT COALESCE(
                        LEAD(h.changed_at) OVER (PARTITION BY h.request_id ORDER BY h.changed_at),
                        now()
                      ) - h.changed_at AS spent,
                      (s->>'sla_minutes')::int AS sla_minutes
               FROM request_status_history h
               JOIN task t ON t.request_id = h.request_id
               JOIN request r ON r.id = h.request_id
               JOIN workflow_definition w ON w.service_type_id = r.service_type_id
               JOIN LATERAL jsonb_array_elements(w.statuses) s ON s->>'key' = h.status
               WHERE t.employee_id = u.id
                 AND h.changed_at >= $2 AND h.changed_at < $3
                 AND s->>'sla_minutes' IS NOT NULL
             ) dwell
            ) AS sla_breach_rate,
            -- Open workload, current snapshot (not period-bound) — same
            -- query shape as autoAssign.js/EmployeesPage.
            (SELECT COUNT(*)::int
             FROM task t
             JOIN request r ON r.id = t.request_id
             JOIN workflow_definition w ON w.service_type_id = r.service_type_id
             JOIN LATERAL jsonb_array_elements(w.statuses) s ON s->>'key' = t.status
             WHERE t.employee_id = u.id AND (s->>'is_terminal')::boolean = FALSE
            ) AS open_count
     FROM users u
     WHERE u.id = ANY($1)`,
    [employeeIds, periodStart, periodEnd]
  );
  return rows;
}

// Scores `targetEmployeeId` against the whole `metricsRows` pool (their
// department). Returns { score, breakdown } — breakdown carries every raw
// figure plus the normalized "goodness" that fed the blend, so a manager
// looking at the number can see what drove it, not just trust it.
function scoreEmployee(metricsRows, targetEmployeeId) {
  const idx = metricsRows.findIndex((r) => r.employee_id === targetEmployeeId);
  if (idx === -1) throw new Error('targetEmployeeId not in metricsRows');

  // "Lower is better" axes: normalize() puts the lowest raw value near 0, so
  // goodness = 1 - normalized (lowest reopen/SLA-breach/resolution -> goodness 1).
  const normReopen = normalize(metricsRows.map((r) => r.reopen_rate));
  const normSla = normalize(metricsRows.map((r) => r.sla_breach_rate));
  const normResolution = normalize(metricsRows.map((r) => r.avg_resolution_minutes));
  // "Higher is better": normalized value IS the goodness directly.
  const normCompleted = normalize(metricsRows.map((r) => r.completed_count));

  const goodness = {
    reopen: 1 - normReopen[idx],
    slaBreach: 1 - normSla[idx],
    resolution: 1 - normResolution[idx],
    completed: normCompleted[idx],
  };
  const score =
    100 *
    (WEIGHTS.reopen * goodness.reopen +
      WEIGHTS.slaBreach * goodness.slaBreach +
      WEIGHTS.resolution * goodness.resolution +
      WEIGHTS.completed * goodness.completed);

  const row = metricsRows[idx];
  return {
    score: Math.round(score * 100) / 100,
    breakdown: {
      weights: WEIGHTS,
      poolSize: metricsRows.length,
      metrics: {
        reopenRate: row.reopen_rate,
        slaBreachRate: row.sla_breach_rate,
        avgResolutionMinutes: row.avg_resolution_minutes,
        completedCount: row.completed_count,
        openCount: row.open_count,
      },
      goodness,
    },
  };
}

module.exports = { loadMetrics, scoreEmployee };

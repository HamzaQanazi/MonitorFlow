// Auto-assign (CLAUDE.md §13 re-scope, deliberate — was previously on the
// "deliberately not built" list). Opt-in per service (service_type.auto_assign,
// set only by an admin building the service, routes/services.js) — every
// other service keeps today's fully-manual flow untouched.
//
// Fires right after a request is created, inside the same transaction as the
// INSERT (called by routes/requests.js). Ranks active employees in the
// service's own department by a weighted blend of three I10-safe outcome
// metrics (reopen rate, avg resolution time, open load — same definitions
// EmployeesPage/dashboard.js already use) and fires the workflow's
// assign-capability transition through workflowEngine's applyTransition — the
// exact same writes a human assign uses (status, task, history, audit,
// notifications), so nothing here re-implements or diverges from that path.
//
// There's no human actor to check Gate 1 (a capability) against, and Gate 2
// holds by construction: the candidate pool IS the service's own department
// (2026-09-04 — service_type.owner_id is gone, department_id is the Gate 2
// anchor directly), so it can never reach outside it. Authorization for this
// action is the service's auto_assign flag itself.
const { applyTransition } = require('./workflowEngine');
const { normalize } = require('./scoring');

// Lower is better for all three metrics. A candidate with no history for a
// metric yet (new hire, nothing completed) gets 0.5 — neutral, neither
// rewarded nor punished — so load ends up being the sole tiebreaker for
// employees with no track record yet, same as the old least-loaded-only pick.
const WEIGHTS = { reopen: 0.5, ttc: 0.3, load: 0.2 };

function rankCandidates(rows) {
  const normReopen = normalize(rows.map((r) => r.reopen_rate));
  const normTtc = normalize(rows.map((r) => r.avg_resolution_minutes));
  const normLoad = normalize(rows.map((r) => r.open_count));
  const scored = rows.map((r, i) => ({
    ...r,
    score: WEIGHTS.reopen * normReopen[i] + WEIGHTS.ttc * normTtc[i] + WEIGHTS.load * normLoad[i],
  }));
  scored.sort((a, b) => a.score - b.score || a.id - b.id);
  return scored[0];
}

// `request` is the just-created row: {id, user_id, status}. `service` is what
// POST /requests already loaded: {departmentId, name, autoAssign, statuses, transitions}.
// Returns the assigned task info, or null if nothing was assigned (disabled,
// no assign-capability transition on this workflow, the department has no
// head to attribute the auto-fire to, or no eligible employee — all of which
// just leave the request unassigned, same as the manual path).
async function maybeAutoAssign(client, { request, service }) {
  if (!service.autoAssign) return null;

  // Derived from the data, not a hardcoded status key (§9): the assign-
  // capability transition out of the request's current (just-created) status.
  const transition = service.transitions.find(
    (t) => t.from === request.status && t.required_capability === 'assign'
  );
  if (!transition) return null;

  // There's no human actor for an auto-fired pick, so the history/audit rows
  // (changed_by is NOT NULL) attribute to the service's department head —
  // also the assignee_manager notification's fallback target. A headless
  // department has nobody to attribute to, so auto-assign just no-ops (same
  // as every other "nothing eligible" case here) rather than crashing on the
  // NOT NULL constraint or silently attributing to some unrelated account.
  const { rows: deptRows } = await client.query(
    'SELECT head_user_id FROM department WHERE id = $1',
    [service.departmentId]
  );
  const departmentHeadId = deptRows[0]?.head_user_id ?? null;
  if (!departmentHeadId) return null;

  const { rows: scopeRows } = await client.query(
    "SELECT id FROM users WHERE department_id = $1 AND role = 'employee' AND is_active",
    [service.departmentId]
  );
  const scope = scopeRows.map((r) => r.id);
  // Ranking inputs, all I10-safe outcome metrics (§2, §5): open load (same
  // subquery as before), avg resolution minutes (same "resolved" definition
  // employees.js/the CSV export use — request creation to the completion-form
  // transition's target status), and reopen rate (same terminal→non-terminal
  // LAG definition dashboard.js uses for its company-wide figure, scoped here
  // per employee via task.employee_id). ponytail: correlated subqueries per
  // candidate — fine for a subtree-sized pool, same tradeoff employees.js
  // already made for its per-row resolution-time column.
  const { rows: candidates } = await client.query(
    `SELECT u.id, u.name,
            (SELECT COUNT(*)::int
             FROM task t
             JOIN request r ON r.id = t.request_id
             JOIN workflow_definition w ON w.service_type_id = r.service_type_id
             JOIN LATERAL jsonb_array_elements(w.statuses) s ON s->>'key' = t.status
             WHERE t.employee_id = u.id AND (s->>'is_terminal')::boolean = FALSE
            ) AS open_count,
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
             WHERE t.employee_id = u.id AND comp.completed_at IS NOT NULL
            ) AS avg_resolution_minutes,
            (SELECT CASE WHEN COUNT(*) FILTER (WHERE hist.is_terminal) = 0 THEN NULL
                    ELSE COUNT(*) FILTER (WHERE hist.prev_terminal AND NOT hist.is_terminal)::float
                         / COUNT(*) FILTER (WHERE hist.is_terminal) END
             FROM (
               SELECT h.changed_at, (s->>'is_terminal')::bool AS is_terminal,
                      LAG((s->>'is_terminal')::bool) OVER (PARTITION BY h.request_id ORDER BY h.changed_at) AS prev_terminal
               FROM request_status_history h
               JOIN task t ON t.request_id = h.request_id
               JOIN request r ON r.id = h.request_id
               JOIN workflow_definition w ON w.service_type_id = r.service_type_id
               JOIN LATERAL jsonb_array_elements(w.statuses) s ON s->>'key' = h.status
               WHERE t.employee_id = u.id
             ) hist
            ) AS reopen_rate
     FROM users u
     WHERE u.id = ANY($1) AND u.role = 'employee' AND u.is_active`,
    [scope]
  );
  if (!candidates.length) return null;
  const employee = rankCandidates(candidates);

  const requestForEngine = {
    id: request.id,
    user_id: request.user_id,
    department_id: service.departmentId,
    department_head_id: departmentHeadId,
    status: request.status,
    service_name: service.name,
    statuses: service.statuses,
  };

  const { status, extra } = await applyTransition(client, {
    request: requestForEngine,
    transition,
    task: null,
    actorId: departmentHeadId,
    note: `Auto-assigned to ${employee.name}`,
    auditAction: 'request.assigned',
    auditDetail: { assigneeId: employee.id, assignee: employee.name, to: transition.to, auto: true },
    beforeCommit: async (tx, ctx) =>
      (
        await tx.query(
          'INSERT INTO task (request_id, employee_id, status) VALUES ($1, $2, $3) RETURNING id, assigned_at',
          [ctx.request.id, employee.id, ctx.transition.to]
        )
      ).rows[0],
  });

  return {
    status,
    task: {
      id: extra.id,
      employeeId: employee.id,
      employeeName: employee.name,
      assignedAt: extra.assigned_at,
    },
  };
}

module.exports = { maybeAutoAssign, rankCandidates };

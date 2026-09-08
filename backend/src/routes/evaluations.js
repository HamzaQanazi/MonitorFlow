// Employee evaluation system (CLAUDE.md §13, supervisor-mandated). A manager
// picks a date range and generates scored evaluations — always a deliberate
// action (no cron, no auto-generation) — for one employee, one department, or
// their whole reachable scope at once (the point being to compare people
// against each other, not just look at one in isolation). Gated the same way
// every other oversight view in the app is (view_all, department-scoped via
// Gate 2, widened by view_all_company; admin sees the whole company).
//
// Staff only (user-directed): an "oversight" employee — one whose level
// grants view_all, I2's own definition of a manager here — doesn't work the
// request queue the way a line employee does, so scoring them on
// completion/reopen/SLA metrics is meaningless, and their near-zero activity
// would only distort the comparison pool for the staff who ARE being scored.
// NOT_OVERSIGHT_SQL excludes them from every pool query and from the
// leaderboard read; a single-employee generate targeting an oversight
// employee is rejected outright (422) rather than silently producing a
// number that doesn't mean anything.
function notOversight(alias) {
  return `NOT EXISTS (SELECT 1 FROM level_capability lc WHERE lc.level_id = ${alias}.level_id AND lc.capability_key = 'view_all')`;
}
const express = require('express');
const pool = require('../db');
const { requireAuth, requireCapabilityOrAdmin } = require('../middleware/auth');
const { ownerInScope, departmentScopeIds } = require('../lib/scope');
const { withTx, logAudit } = require('../lib/audit');
const { loadMetrics, loadSelfComparisonMetrics, scoreEmployee } = require('../lib/evaluationMetrics');

const router = express.Router();
router.use(requireAuth);
router.use(requireCapabilityOrAdmin('view_all'));

// Same 404-over-403 shape as employees.js's loadEmployeeInScope: a valid id
// outside the actor's scope reads as "doesn't exist," not "forbidden."
async function loadEmployeeInScope(actor, id) {
  const { rows } = await pool.query(
    "SELECT id, name, department_id, level_id FROM users WHERE id = $1 AND role = 'employee'",
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  if (actor.role !== 'admin' && !(await ownerInScope(actor.id, id))) return null;
  return row;
}

async function isOversightLevel(levelId) {
  if (levelId == null) return false;
  const { rows } = await pool.query(
    "SELECT 1 FROM level_capability WHERE level_id = $1 AND capability_key = 'view_all'",
    [levelId]
  );
  return rows.length > 0;
}

function isValidDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function publicEvaluation(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    score: Number(r.score),
    breakdown: r.breakdown,
    generatedBy: r.generated_by,
    generatedByName: r.generated_by_name,
    generatedAt: r.generated_at,
  };
}

// Inserts one immutable evaluation row + its matching audit row, in the
// caller's transaction. Shared by the single-employee and per-department
// generate paths so there's exactly one write path to keep in sync.
async function insertEvaluation(tx, { employeeId, employeeName, departmentId, periodStart, periodEnd, score, breakdown, actorId }) {
  const { rows } = await tx.query(
    `INSERT INTO employee_evaluation (employee_id, period_start, period_end, score, breakdown, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, employee_id, period_start, period_end, score, breakdown, generated_by, generated_at`,
    [employeeId, periodStart, periodEnd, score, JSON.stringify(breakdown), actorId]
  );
  await logAudit(tx, actorId, 'evaluation.generated', 'employee_evaluation', rows[0].id, {
    employeeId, employeeName, departmentId, periodStart, periodEnd, score,
  });
  return rows[0];
}

// Scores every active employee in `departmentId` against each other (the
// same comparison pool a single-employee generate already used, just scoring
// every row in it instead of extracting one) and inserts one immutable row
// per employee, all in the same transaction. A department with exactly one
// active employee has no peers to compare against, so that one employee
// falls back to loadSelfComparisonMetrics (their own prior period) instead —
// see evaluationMetrics.js. Returns the inserted rows — empty if the
// department currently has no active employees.
async function generateForDepartment(tx, { departmentId, periodStart, periodEnd, actorId }) {
  const { rows: poolRows } = await tx.query(
    `SELECT id, name FROM users u
     WHERE role = 'employee' AND department_id = $1 AND is_active AND ${notOversight('u')}`,
    [departmentId]
  );
  if (!poolRows.length) return [];

  const saved = [];
  if (poolRows.length > 1) {
    const metricsRows = await loadMetrics(poolRows.map((r) => r.id), periodStart, periodEnd);
    for (const row of metricsRows) {
      const { score, breakdown } = scoreEmployee(metricsRows, row.employee_id);
      saved.push(
        await insertEvaluation(tx, {
          employeeId: row.employee_id,
          employeeName: row.employee_name,
          departmentId,
          periodStart,
          periodEnd,
          score,
          breakdown,
          actorId,
        })
      );
    }
  } else {
    const [{ id: employeeId, name: employeeName }] = poolRows;
    const metricsRows = await loadSelfComparisonMetrics(employeeId, periodStart, periodEnd);
    const { score, breakdown } = scoreEmployee(metricsRows, employeeId);
    saved.push(
      await insertEvaluation(tx, { employeeId, employeeName, departmentId, periodStart, periodEnd, score, breakdown, actorId })
    );
  }
  return saved;
}

router.post('/generate', async (req, res, next) => {
  try {
    const { employeeId, departmentId, periodStart, periodEnd } = req.body || {};
    const errors = {};
    if (employeeId !== undefined && !Number.isInteger(employeeId)) errors.employeeId = 'Must be an integer';
    if (departmentId !== undefined && !Number.isInteger(departmentId)) errors.departmentId = 'Must be an integer';
    if (employeeId !== undefined && departmentId !== undefined) {
      errors.departmentId = 'Choose either an employee or a department, not both';
    }
    if (!isValidDate(periodStart)) errors.periodStart = 'Required, must be a valid date';
    if (!isValidDate(periodEnd)) errors.periodEnd = 'Required, must be a valid date';
    if (!errors.periodStart && !errors.periodEnd && periodStart >= periodEnd) {
      errors.periodEnd = 'Must be after periodStart';
    }
    if (Object.keys(errors).length) return res.status(422).json({ errors });

    // Single employee: scored against their own department peers — or, if
    // they have none active, against their own prior period instead
    // (loadSelfComparisonMetrics; a different department's work isn't
    // directly comparable).
    if (employeeId !== undefined) {
      const employee = await loadEmployeeInScope(req.user, employeeId);
      if (!employee) return res.status(404).json({ error: 'Not found' });
      if (await isOversightLevel(employee.level_id)) {
        return res.status(422).json({
          errors: { employeeId: 'This employee holds oversight capabilities and isn’t evaluated — evaluations are for staff who work the request queue' },
        });
      }

      const { rows: poolRows } = await pool.query(
        `SELECT id FROM users u
         WHERE role = 'employee'
           AND (id = $1 OR (department_id = $2 AND is_active))
           AND ${notOversight('u')}`,
        [employee.id, employee.department_id]
      );
      const metricsRows =
        poolRows.length > 1
          ? await loadMetrics(poolRows.map((r) => r.id), periodStart, periodEnd)
          : await loadSelfComparisonMetrics(employee.id, periodStart, periodEnd);
      const { score, breakdown } = scoreEmployee(metricsRows, employee.id);

      const saved = await withTx((tx) =>
        insertEvaluation(tx, {
          employeeId: employee.id,
          employeeName: employee.name,
          departmentId: employee.department_id,
          periodStart,
          periodEnd,
          score,
          breakdown,
          actorId: req.user.id,
        })
      );

      return res
        .status(201)
        .json({ evaluations: [publicEvaluation({ ...saved, generated_by_name: req.user.name })] });
    }

    // Department, or (if omitted) every department the actor can reach — a
    // plain department manager only ever reaches their own department here
    // (so this is just "generate for my team"); an admin or a level holding
    // view_all_company reaches every department (so leaving departmentId off
    // is "generate for the whole company"). No separate permission check
    // needed: departmentScopeIds already encodes exactly this via Gate 2.
    const reachable = await departmentScopeIds(req.user);
    let targetDepartmentIds;
    if (departmentId !== undefined) {
      if (!reachable.includes(departmentId)) return res.status(404).json({ error: 'Not found' });
      targetDepartmentIds = [departmentId];
    } else {
      targetDepartmentIds = reachable;
    }

    const saved = await withTx(async (tx) => {
      const all = [];
      for (const deptId of targetDepartmentIds) {
        const rows = await generateForDepartment(tx, {
          departmentId: deptId,
          periodStart,
          periodEnd,
          actorId: req.user.id,
        });
        all.push(...rows);
      }
      return all;
    });

    const evaluations = saved
      .map((r) => publicEvaluation({ ...r, generated_by_name: req.user.name }))
      .sort((a, b) => b.score - a.score);
    res.status(201).json({ evaluations });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    // Full history for one employee — unchanged.
    if (req.query.employeeId !== undefined) {
      const employeeId = Number(req.query.employeeId);
      if (!Number.isInteger(employeeId)) return res.status(422).json({ errors: { employeeId: 'Required' } });

      const employee = await loadEmployeeInScope(req.user, employeeId);
      if (!employee) return res.status(404).json({ error: 'Not found' });

      const { rows } = await pool.query(
        `SELECT e.id, e.employee_id, e.period_start, e.period_end, e.score, e.breakdown,
                e.generated_by, u.name AS generated_by_name, e.generated_at
         FROM employee_evaluation e
         JOIN users u ON u.id = e.generated_by
         WHERE e.employee_id = $1
         ORDER BY e.period_start DESC, e.generated_at DESC`,
        [employeeId]
      );
      return res.json({ evaluations: rows.map(publicEvaluation) });
    }

    // Comparison view: the most recent evaluation per employee, across one
    // department or the actor's whole reachable scope (same collapsing rule
    // as POST /generate) — a leaderboard for whatever was last generated.
    const reachable = await departmentScopeIds(req.user);
    let departmentIds = reachable;
    if (req.query.departmentId !== undefined) {
      const departmentId = Number(req.query.departmentId);
      if (!Number.isInteger(departmentId)) return res.status(422).json({ errors: { departmentId: 'Invalid' } });
      if (!reachable.includes(departmentId)) return res.status(404).json({ error: 'Not found' });
      departmentIds = [departmentId];
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (e.employee_id)
              e.id, e.employee_id, e.period_start, e.period_end, e.score, e.breakdown,
              e.generated_by, u.name AS generated_by_name, e.generated_at
       FROM employee_evaluation e
       JOIN users u ON u.id = e.generated_by
       JOIN users emp ON emp.id = e.employee_id
       WHERE emp.department_id = ANY($1) AND ${notOversight('emp')}
       ORDER BY e.employee_id, e.generated_at DESC`,
      [departmentIds]
    );
    const evaluations = rows.map(publicEvaluation).sort((a, b) => b.score - a.score);
    res.json({ evaluations });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.employee_id, e.period_start, e.period_end, e.score, e.breakdown,
              e.generated_by, u.name AS generated_by_name, e.generated_at
       FROM employee_evaluation e
       JOIN users u ON u.id = e.generated_by
       WHERE e.id = $1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && !(await ownerInScope(req.user.id, row.employee_id))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ evaluation: publicEvaluation(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// Employee evaluation system (CLAUDE.md §13, supervisor-mandated). A manager
// picks a date range and generates scored evaluations — always a deliberate
// action (no cron, no auto-generation) — for one employee, one department, or
// their whole reachable scope at once (the point being to compare people
// against each other, not just look at one in isolation). Gated the same way
// every other oversight view in the app is (view_all, department-scoped via
// Gate 2, widened by view_all_company; admin sees the whole company).
const express = require('express');
const pool = require('../db');
const { requireAuth, requireCapabilityOrAdmin } = require('../middleware/auth');
const { ownerInScope, departmentScopeIds } = require('../lib/scope');
const { withTx, logAudit } = require('../lib/audit');
const { loadMetrics, scoreEmployee } = require('../lib/evaluationMetrics');

const router = express.Router();
router.use(requireAuth);
router.use(requireCapabilityOrAdmin('view_all'));

// Same 404-over-403 shape as employees.js's loadEmployeeInScope: a valid id
// outside the actor's scope reads as "doesn't exist," not "forbidden."
async function loadEmployeeInScope(actor, id) {
  const { rows } = await pool.query(
    "SELECT id, name, department_id FROM users WHERE id = $1 AND role = 'employee'",
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  if (actor.role !== 'admin' && !(await ownerInScope(actor.id, id))) return null;
  return row;
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

// Scores every active employee in `departmentId` against each other (the
// same comparison pool a single-employee generate already used, just scoring
// every row in it instead of extracting one) and inserts one immutable row
// per employee, all in the same transaction. Returns the inserted rows —
// empty if the department currently has no active employees.
async function generateForDepartment(tx, { departmentId, periodStart, periodEnd, actorId }) {
  const { rows: poolRows } = await tx.query(
    "SELECT id FROM users WHERE role = 'employee' AND department_id = $1 AND is_active",
    [departmentId]
  );
  const poolIds = poolRows.map((r) => r.id);
  if (!poolIds.length) return [];

  const metricsRows = await loadMetrics(poolIds, periodStart, periodEnd);
  const saved = [];
  for (const row of metricsRows) {
    const { score, breakdown } = scoreEmployee(metricsRows, row.employee_id);
    const { rows } = await tx.query(
      `INSERT INTO employee_evaluation (employee_id, period_start, period_end, score, breakdown, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, employee_id, period_start, period_end, score, breakdown, generated_by, generated_at`,
      [row.employee_id, periodStart, periodEnd, score, JSON.stringify(breakdown), actorId]
    );
    await logAudit(tx, actorId, 'evaluation.generated', 'employee_evaluation', rows[0].id, {
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      departmentId,
      periodStart,
      periodEnd,
      score,
    });
    saved.push(rows[0]);
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

    // Single employee: unchanged behavior, scored against their own
    // department peers (the comparison pool).
    if (employeeId !== undefined) {
      const employee = await loadEmployeeInScope(req.user, employeeId);
      if (!employee) return res.status(404).json({ error: 'Not found' });

      const { rows: poolRows } = await pool.query(
        `SELECT id FROM users
         WHERE role = 'employee'
           AND (id = $1 OR (department_id = $2 AND is_active))`,
        [employee.id, employee.department_id]
      );
      const poolIds = poolRows.map((r) => r.id);
      const metricsRows = await loadMetrics(poolIds, periodStart, periodEnd);
      const { score, breakdown } = scoreEmployee(metricsRows, employee.id);

      const saved = await withTx(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO employee_evaluation (employee_id, period_start, period_end, score, breakdown, generated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, employee_id, period_start, period_end, score, breakdown, generated_by, generated_at`,
          [employee.id, periodStart, periodEnd, score, JSON.stringify(breakdown), req.user.id]
        );
        await logAudit(tx, req.user.id, 'evaluation.generated', 'employee_evaluation', rows[0].id, {
          employeeId: employee.id,
          employeeName: employee.name,
          periodStart,
          periodEnd,
          score,
        });
        return rows[0];
      });

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
       WHERE emp.department_id = ANY($1)
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

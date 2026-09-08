// Employee evaluation system (CLAUDE.md §13, supervisor-mandated). A manager
// picks one employee + a date range and generates a scored evaluation —
// always a deliberate action (no cron, no auto-generation), gated the same
// way every other oversight view in the app is (view_all, department-scoped
// via Gate 2, widened by view_all_company; admin sees the whole company).
const express = require('express');
const pool = require('../db');
const { requireAuth, requireCapabilityOrAdmin } = require('../middleware/auth');
const { ownerInScope } = require('../lib/scope');
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

router.post('/generate', async (req, res, next) => {
  try {
    const { employeeId, periodStart, periodEnd } = req.body || {};
    const errors = {};
    if (!Number.isInteger(employeeId)) errors.employeeId = 'Required';
    if (!isValidDate(periodStart)) errors.periodStart = 'Required, must be a valid date';
    if (!isValidDate(periodEnd)) errors.periodEnd = 'Required, must be a valid date';
    if (!errors.periodStart && !errors.periodEnd && periodStart >= periodEnd) {
      errors.periodEnd = 'Must be after periodStart';
    }
    if (Object.keys(errors).length) return res.status(422).json({ errors });

    const employee = await loadEmployeeInScope(req.user, employeeId);
    if (!employee) return res.status(404).json({ error: 'Not found' });

    // Comparison pool: the employee's own department peers (Gate 2's own
    // unit, same reasoning as autoAssign's candidate pool) plus the target
    // themself even if since deactivated or department-less, so a departed
    // or unassigned employee can still be evaluated solo (normalize()'s
    // <2-points rule then neutrals every relative axis to 0.5).
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

    res.status(201).json({ evaluation: publicEvaluation({ ...saved, generated_by_name: req.user.name }) });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
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
    res.json({ evaluations: rows.map(publicEvaluation) });
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

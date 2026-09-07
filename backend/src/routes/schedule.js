// Schedule (`schedule` onboarding key): a manager assigns a named
// shift_template to a subtree employee for a specific date (schedule_entry) —
// a flat, date-by-date roster the manager re-fills a week at a time, no
// recurrence engine (see 018_schedule.sql). This is also Time Clock's
// late/absent/overtime baseline now (lib/timeClock.js reads schedule_entry
// per date instead of the old employee_default_shift).
const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole, requireCapabilityOrAdmin, requireFeature } = require('../middleware/auth');
const { withTx, logAudit } = require('../lib/audit');
const { ownerScopeIds } = require('../lib/scope');
const { companyDate } = require('../lib/timeClock');
const { isBilingual } = require('../lib/i18nLabel');
const { solveSchedule } = require('../lib/scheduleSolver');

const router = express.Router();
router.use(requireAuth);
router.use(requireFeature('schedule'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function serializeTemplate(t) {
  return { id: t.id, name: t.name, startTime: t.start_time, endTime: t.end_time };
}

// ---- Shift templates (manager, view_all to read, manage_employees to write) ----

router.get('/templates', requireCapabilityOrAdmin('view_all'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, start_time, end_time FROM shift_template WHERE company_id = $1 ORDER BY start_time',
      [req.user.company_id]
    );
    res.json({ templates: rows.map(serializeTemplate) });
  } catch (err) {
    next(err);
  }
});

router.post('/templates', requireCapabilityOrAdmin('manage_employees'), async (req, res, next) => {
  try {
    const { name, startTime, endTime } = req.body || {};
    const errors = {};
    if (!isBilingual(name)) errors.name = 'A name is required in both languages';
    if (!TIME_RE.test(startTime || '')) errors.startTime = 'startTime must be HH:MM';
    if (!TIME_RE.test(endTime || '')) errors.endTime = 'endTime must be HH:MM';
    if (Object.keys(errors).length) return res.status(422).json({ errors });

    const template = await withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO shift_template (company_id, name, start_time, end_time)
         VALUES ($1, $2, $3, $4) RETURNING id, name, start_time, end_time`,
        [req.user.company_id, JSON.stringify(name), startTime, endTime]
      );
      await logAudit(client, req.user.id, 'shift_template.created', 'shift_template', rows[0].id, { name });
      return rows[0];
    });
    res.status(201).json({ template: serializeTemplate(template) });
  } catch (err) {
    next(err);
  }
});

// Time Clock's late/absent/overtime math (lib/timeClock.js) joins
// schedule_entry -> shift_template and reads the CURRENT start/end, so editing
// a template's hours rewrites what the Today tab, the timesheet grid, and the
// payroll CSV say about days that already happened. Same hazard §3 addresses
// for form/workflow definitions: once it has been used, it is frozen. Only the
// hours are — the bilingual name is a label and never feeds the math, so
// renaming stays allowed, and a template used only on future dates is still
// fully editable.
async function usedOnAPastDate(templateId) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM schedule_entry WHERE shift_template_id = $1 AND date < $2::date LIMIT 1',
    [templateId, companyDate(new Date())]
  );
  return rowCount > 0;
}

router.patch('/templates/:id', requireCapabilityOrAdmin('manage_employees'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, startTime, endTime } = req.body || {};
    const errors = {};
    if (name !== undefined && !isBilingual(name)) errors.name = 'A name is required in both languages';
    if (startTime !== undefined && !TIME_RE.test(startTime || '')) errors.startTime = 'startTime must be HH:MM';
    if (endTime !== undefined && !TIME_RE.test(endTime || '')) errors.endTime = 'endTime must be HH:MM';
    if (Object.keys(errors).length) return res.status(422).json({ errors });

    const current = (
      await pool.query('SELECT start_time, end_time FROM shift_template WHERE id = $1 AND company_id = $2', [
        id,
        req.user.company_id,
      ])
    ).rows[0];
    if (!current) return res.status(404).json({ error: 'Not found' });

    // pg hands back TIME as 'HH:MM:SS'; the client sends 'HH:MM'.
    const hoursChanged =
      (startTime !== undefined && startTime !== current.start_time.slice(0, 5)) ||
      (endTime !== undefined && endTime !== current.end_time.slice(0, 5));
    if (hoursChanged && (await usedOnAPastDate(id))) {
      return res.status(409).json({
        error: 'This shift has already been worked on past dates — changing its hours would rewrite attendance history. Create a new shift instead.',
      });
    }

    const template = await withTx(async (client) => {
      const { rows } = await client.query(
        `UPDATE shift_template SET
           name = COALESCE($1, name),
           start_time = COALESCE($2, start_time),
           end_time = COALESCE($3, end_time)
         WHERE id = $4 AND company_id = $5
         RETURNING id, name, start_time, end_time`,
        [name ? JSON.stringify(name) : null, startTime || null, endTime || null, id, req.user.company_id]
      );
      if (!rows.length) return null;
      await logAudit(client, req.user.id, 'shift_template.updated', 'shift_template', id, { name, startTime, endTime });
      return rows[0];
    });
    if (!template) return res.status(404).json({ error: 'Not found' });
    res.json({ template: serializeTemplate(template) });
  } catch (err) {
    next(err);
  }
});

router.delete('/templates/:id', requireCapabilityOrAdmin('manage_employees'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rowCount: used } = await pool.query('SELECT 1 FROM schedule_entry WHERE shift_template_id = $1 LIMIT 1', [id]);
    if (used) return res.status(409).json({ error: 'Template is used by scheduled shifts' });

    const deleted = await withTx(async (client) => {
      const { rowCount } = await client.query('DELETE FROM shift_template WHERE id = $1 AND company_id = $2', [
        id,
        req.user.company_id,
      ]);
      if (rowCount) await logAudit(client, req.user.id, 'shift_template.deleted', 'shift_template', id);
      return rowCount > 0;
    });
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    // The pre-check above runs on its own connection, so a roster write can
    // land between it and the DELETE. The FK (NO ACTION) is the real guard —
    // report it as the same 409 rather than letting it surface as a 500.
    if (err.code === '23503') return res.status(409).json({ error: 'Template is used by scheduled shifts' });
    next(err);
  }
});

// ---- Roster (manager, subtree-scoped) ----

// GET /schedule/roster?from&to — one row per subtree employee, with every
// schedule_entry in [from, to] (inclusive). The web Roster grid renders this.
router.get('/roster', requireCapabilityOrAdmin('view_all'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    // ownerScopeIds, not subtreeIds: the Owner is an admin with no subtree
    // (I2), so a raw subtree walk left them with an empty roster they also
    // could not write to (every employeeId failed the PUT's scope check).
    const ids = await ownerScopeIds(req.user);
    const [{ rows: employees }, { rows: entries }] = await Promise.all([
      pool.query(`SELECT id, name FROM users WHERE id = ANY($1::int[]) AND role = 'employee' AND is_active ORDER BY name`, [
        ids,
      ]),
      pool.query(
        `SELECT se.employee_id, se.date::text AS date, st.id AS template_id,
                st.name AS template_name, st.start_time, st.end_time
         FROM schedule_entry se
         JOIN shift_template st ON st.id = se.shift_template_id
         WHERE se.employee_id = ANY($1::int[]) AND se.date BETWEEN $2 AND $3`,
        [ids, from, to]
      ),
    ]);

    const entriesByEmployee = new Map();
    for (const e of entries) {
      if (!entriesByEmployee.has(e.employee_id)) entriesByEmployee.set(e.employee_id, []);
      entriesByEmployee.get(e.employee_id).push({
        date: e.date,
        templateId: e.template_id,
        templateName: e.template_name,
        startTime: e.start_time,
        endTime: e.end_time,
      });
    }

    res.json({
      employees: employees.map((emp) => ({
        employeeId: emp.id,
        name: emp.name,
        entries: entriesByEmployee.get(emp.id) || [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /schedule/roster — bulk upsert. { entries: [{employeeId, date, templateId}] },
// templateId: null clears that employee's day. Every employeeId must be in the
// caller's scope (404-over-403, same shape as tasks.js); an unknown templateId
// trips the FK and comes back 422. (The FK proves the template EXISTS, not that
// it belongs to this company — indistinguishable while a deployment holds one
// company, §13, but it is not the company check it looks like.)
router.put('/roster', requireCapabilityOrAdmin('manage_employees'), async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries || !entries.length) return res.status(422).json({ errors: { entries: 'At least one entry is required' } });
    if (entries.length > 500) return res.status(422).json({ errors: { entries: 'Too many entries in one request' } });
    for (const e of entries) {
      if (!Number.isInteger(e.employeeId) || !DATE_RE.test(e.date || '') || (e.templateId !== null && !Number.isInteger(e.templateId))) {
        return res.status(422).json({ errors: { entries: 'Each entry needs employeeId, date, and templateId (or null)' } });
      }
    }

    const ids = new Set(await ownerScopeIds(req.user));
    if (entries.some((e) => !ids.has(e.employeeId))) return res.status(404).json({ error: 'Not found' });

    await withTx(async (client) => {
      for (const e of entries) {
        if (e.templateId === null) {
          const { rows } = await client.query('DELETE FROM schedule_entry WHERE employee_id = $1 AND date = $2 RETURNING id', [
            e.employeeId,
            e.date,
          ]);
          if (rows.length) {
            await logAudit(client, req.user.id, 'schedule_entry.cleared', 'schedule_entry', rows[0].id, {
              employeeId: e.employeeId,
              date: e.date,
            });
          }
        } else {
          const { rows } = await client.query(
            `INSERT INTO schedule_entry (employee_id, company_id, date, shift_template_id, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (employee_id, date)
             DO UPDATE SET shift_template_id = EXCLUDED.shift_template_id, created_by = EXCLUDED.created_by, created_at = now()
             RETURNING id`,
            [e.employeeId, req.user.company_id, e.date, e.templateId, req.user.id]
          );
          await logAudit(client, req.user.id, 'schedule_entry.set', 'schedule_entry', rows[0].id, {
            employeeId: e.employeeId,
            date: e.date,
            templateId: e.templateId,
          });
        }
      }
    });

    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(422).json({ errors: { entries: 'Invalid template id' } });
    next(err);
  }
});

// POST /schedule/suggest — preview-only: proposes roster entries for a manager
// to review, never writes schedule_entry itself (AI scheduling track, CLAUDE.md
// §13 — a human stays in the loop, unlike auto-assign's opt-in-and-fire). Local
// computation over existing data, no vendor call. Fills one template across
// the chosen weekdays for the chosen (or whole-subtree) employee pool via
// lib/scheduleSolver.js's backtracking CSP solver: nobody is double-booked
// the same day, a `users.weekly_rest_day` pin is always honored, and — once
// >=2 weekdays are selected — every employee is guaranteed at least one
// unassigned offered day, chosen by the solver when nobody pinned a
// specific one. `from`/`to` is capped to one calendar week (user-directed,
// see the range check below) — a manager generates one week at a time.
// See scheduleSolver.js for why a plain greedy fill isn't enough to keep
// that guarantee. Never overwrites an existing schedule_entry — the
// manager applies the result via the existing PUT /schedule/roster, so
// this has no write path of its own.
router.post('/suggest', requireCapabilityOrAdmin('manage_employees'), async (req, res, next) => {
  try {
    const { from, to, templateId, weekdays, employeeIds, perDay } = req.body || {};
    const errors = {};
    if (!DATE_RE.test(from || '')) errors.from = 'from must be YYYY-MM-DD';
    if (!DATE_RE.test(to || '')) errors.to = 'to must be YYYY-MM-DD';
    if (!Number.isInteger(templateId)) errors.templateId = 'templateId is required';
    // JS Date#getUTCDay() convention: 0=Sunday … 6=Saturday.
    const days = new Set(Array.isArray(weekdays) ? weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : []);
    if (!days.size) errors.weekdays = 'Pick at least one weekday';
    if (employeeIds !== undefined && !(Array.isArray(employeeIds) && employeeIds.every(Number.isInteger))) {
      errors.employeeIds = 'employeeIds must be an array of ids';
    }
    if (perDay !== undefined && !(Number.isInteger(perDay) && perDay > 0)) errors.perDay = 'perDay must be a positive integer';
    if (Object.keys(errors).length) return res.status(422).json({ errors });
    if (from > to) return res.status(422).json({ errors: { to: 'to must be on or after from' } });
    // Capped to one calendar week, user-directed (was: up to 90 days,
    // solved as several independent weeks) — a manager generates one week
    // at a time, same as the Roster grid always displays one week and
    // Copy Last Week always copies one. lib/scheduleSolver.js relies on
    // this: it never buckets or splits its `dates` input by week anymore,
    // it just treats the whole thing as "the week."
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 6) {
      return res.status(422).json({ errors: { to: 'Range is limited to one week' } });
    }

    const template = (
      await pool.query('SELECT id, name, start_time, end_time FROM shift_template WHERE id = $1 AND company_id = $2', [
        templateId,
        req.user.company_id,
      ])
    ).rows[0];
    if (!template) return res.status(404).json({ error: 'Not found' });

    const subtree = await ownerScopeIds(req.user);
    if (employeeIds?.length) {
      const allowed = new Set(subtree);
      if (employeeIds.some((id) => !allowed.has(id))) return res.status(404).json({ error: 'Not found' });
    }
    const poolIds = employeeIds?.length ? employeeIds : subtree;

    const { rows: employees } = await pool.query(
      `SELECT id, name, weekly_rest_day FROM users WHERE id = ANY($1::int[]) AND role = 'employee' AND is_active ORDER BY id`,
      [poolIds]
    );
    if (!employees.length) {
      return res.json({ entries: [], template: serializeTemplate(template), alreadyScheduledSkipped: 0, restDaySkipped: 0 });
    }

    const { rows: existing } = await pool.query(
      `SELECT employee_id, date::text AS date FROM schedule_entry WHERE employee_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
      [poolIds, from, to]
    );
    const alreadyScheduled = new Set(existing.map((e) => `${e.employee_id}|${e.date}`));

    const dates = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1)) {
      if (days.has(new Date(`${d}T00:00:00Z`).getUTCDay())) dates.push(d);
    }
    const cap = Number.isInteger(perDay) ? perDay : employees.length;
    if (dates.length * cap > 500) {
      return res.status(422).json({ errors: { to: 'Suggestion is too large — narrow the range or weekdays' } });
    }

    const { entries, restDaySkipped, alreadyScheduledSkipped } = solveSchedule({
      dates,
      cap,
      weekdayCount: days.size,
      employees: employees.map((e) => ({ id: e.id, name: e.name, weeklyRestDay: e.weekly_rest_day })),
      alreadyScheduled,
    });
    for (const e of entries) e.templateId = template.id;

    res.json({ entries, template: serializeTemplate(template), alreadyScheduledSkipped, restDaySkipped });
  } catch (err) {
    next(err);
  }
});

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- Self-service ----

// GET /schedule/mine?from&to — the caller's own upcoming schedule. Employee
// only (the Owner has no schedule_entry rows of their own) — everything else
// in this router admits the admin too, see requireCapabilityOrAdmin above.
router.get('/mine', requireRole('employee'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    const { rows } = await pool.query(
      `SELECT se.date::text AS date, st.id AS template_id, st.name AS template_name, st.start_time, st.end_time
       FROM schedule_entry se
       JOIN shift_template st ON st.id = se.shift_template_id
       WHERE se.employee_id = $1 AND se.date BETWEEN $2 AND $3
       ORDER BY se.date`,
      [req.user.id, from, to]
    );
    res.json({
      entries: rows.map((r) => ({
        date: r.date,
        templateId: r.template_id,
        templateName: r.template_name,
        startTime: r.start_time,
        endTime: r.end_time,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

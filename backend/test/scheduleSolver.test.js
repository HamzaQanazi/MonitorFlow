// Unit tests for lib/scheduleSolver.js — no DB/server needed, pure function.
// Each test is here to prove one specific design decision, not just to pad
// coverage — see lib/scheduleSolver.js's header comment for the reasoning
// each one is checking. `dates` is always at most one calendar week's worth
// of days (routes/schedule.js enforces the 7-day cap before this is called).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveSchedule } = require('../src/lib/scheduleSolver');

test('a pin on one employee forces backtracking, not just forward filtering', () => {
  // A (id 1, no pin) and B (id 2, pinned off Tuesday). Only A/B exist, one
  // slot per day, Monday+Tuesday. A greedy forward pass tries A on Monday
  // (tie-break: lower id first when loads are equal) and only then
  // discovers Tuesday is unsolvable (B is pinned off, and A has already
  // used their one day-off-eligible slot for the week) — a real dead end
  // that can only be fixed by undoing the Monday choice and trying B
  // instead. See the module comment for the full trace.
  const result = solveSchedule({
    dates: ['2026-09-07', '2026-09-08'], // Mon, Tue
    cap: 1,
    weekdayCount: 2,
    employees: [
      { id: 1, name: 'A', weeklyRestDay: null },
      { id: 2, name: 'B', weeklyRestDay: 2 }, // Tuesday
    ],
    alreadyScheduled: new Set(),
  });
  assert.deepEqual(
    result.entries.map((e) => [e.date, e.employeeId]),
    [
      ['2026-09-07', 2], // B works Monday...
      ['2026-09-08', 1], // ...freeing Tuesday for A, who still needs a day off this week
    ]
  );
  assert.equal(result.restDaySkipped, 1); // B's pin, counted on the Tuesday it applies
  assert.equal(result.alreadyScheduledSkipped, 0);
});

test('matches the old greedy tie-break when the day-off constraint never bites', () => {
  // Same shape as backend/test/scheduleSuggest.api.test.js's rotation
  // test: two employees, no pins, one slot/day — with only two employees
  // for two days, the fair split IS the day-off guarantee, so this should
  // come out identical to the pre-backtracking greedy (lower id first).
  const result = solveSchedule({
    dates: ['2026-09-07', '2026-09-08'],
    cap: 1,
    weekdayCount: 2,
    employees: [
      { id: 1, name: 'field1', weeklyRestDay: null },
      { id: 2, name: 'field2', weeklyRestDay: null },
    ],
    alreadyScheduled: new Set(),
  });
  assert.deepEqual(
    result.entries.map((e) => [e.date, e.employeeId]),
    [
      ['2026-09-07', 1],
      ['2026-09-08', 2],
    ]
  );
});

test('a single selected weekday never triggers the day-off constraint', () => {
  // One employee, one day, one weekday selected. If the day-off guarantee
  // were (wrongly) applied here, this would be treated as "the only
  // offered day this week" and the employee would be excluded from their
  // own last-and-only day, leaving the slot empty for no reason. A single
  // selected weekday means there's no rotation to enforce in the first
  // place (see the module comment for why).
  const result = solveSchedule({
    dates: ['2026-09-07'],
    cap: 1,
    weekdayCount: 1,
    employees: [{ id: 1, name: 'C', weeklyRestDay: null }],
    alreadyScheduled: new Set(),
  });
  assert.deepEqual(result.entries, [{ employeeId: 1, employeeName: 'C', date: '2026-09-07' }]);
});

test('an infeasible week falls back to a plain fill rather than leaving slots empty', () => {
  // 4 employees (ids 1-4), perDay 2, Mon+Tue. Employee 4 is already
  // scheduled elsewhere both days, so only 3 people are ever eligible for
  // 2 slots/day across 2 days — needing 4 person-days from a pool where
  // nobody can ethically work more than 1 of the 2 days is impossible (max
  // fair coverage 3 < 4 needed). The strict pass must fail, and the
  // fallback should still fully staff both days — someone just ends up
  // working both, instead of a slot silently going unfilled.
  const result = solveSchedule({
    dates: ['2026-09-07', '2026-09-08'],
    cap: 2,
    weekdayCount: 2,
    employees: [
      { id: 1, name: 'W', weeklyRestDay: null },
      { id: 2, name: 'X', weeklyRestDay: null },
      { id: 3, name: 'Y', weeklyRestDay: null },
      { id: 4, name: 'Z', weeklyRestDay: null },
    ],
    alreadyScheduled: new Set(['4|2026-09-07', '4|2026-09-08']),
  });

  assert.equal(result.entries.length, 4); // both days fully staffed, nothing left empty
  const worked = new Map();
  for (const e of result.entries) worked.set(e.employeeId, (worked.get(e.employeeId) || 0) + 1);
  assert.ok([...worked.values()].some((count) => count === 2), 'someone necessarily works both days — the guarantee is infeasible here');
  assert.equal(result.alreadyScheduledSkipped, 2); // employee 4, both days
});

test('the weekly fair ceiling stops one employee spiking while others sit idle', () => {
  // Bug found by manually testing the feature (not hypothetical): the
  // day-off floor alone let one employee soak up most of a week's slots
  // while their running total was still low, then get skipped for several
  // weeks afterward. 10 employees, cap 2/day, a full 7-day week: 14 slots
  // total, weekCap = ceil(14/10) = 2 — nobody should ever exceed 2 shifts
  // this week no matter how "cheap" the tie-break thinks they are.
  const employees = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, weeklyRestDay: null }));
  const dates = [];
  let d = new Date('2026-09-07T00:00:00Z'); // Monday, full week
  for (let i = 0; i < 7; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const result = solveSchedule({ dates, cap: 2, weekdayCount: 7, employees, alreadyScheduled: new Set() });
  assert.equal(result.entries.length, 14);

  const counts = new Map();
  for (const e of result.entries) counts.set(e.employeeId, (counts.get(e.employeeId) || 0) + 1);
  assert.ok([...counts.values()].every((c) => c <= 2), 'nobody exceeds the fair weekly ceiling');
});

test('a heavily saturated request terminates quickly instead of hanging', () => {
  // Measured before STEP_BUDGET existed: 20 employees, cap 17/day, all 7
  // days of the week — right at the edge of "barely possible while
  // everyone still gets a break" — took several seconds of plain
  // backtracking before it was cut off. Must now come back in well under
  // a second by falling back to the guarantee-off pass once the strict
  // search burns through its step budget.
  const employees = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, weeklyRestDay: null }));
  const dates = [];
  let d = new Date('2026-09-07T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const start = process.hrtime.bigint();
  const result = solveSchedule({ dates, cap: 17, weekdayCount: 7, employees, alreadyScheduled: new Set() });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(ms < 5000, `expected well under 5s, took ${ms.toFixed(0)}ms`);
  assert.equal(result.entries.length, 17 * 7);
});

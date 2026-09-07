// Unit tests for lib/scheduleSolver.js — no DB/server needed, pure function.
// Each test is here to prove one specific design decision, not just to pad
// coverage — see lib/scheduleSolver.js's header comment for the reasoning
// each one is checking.
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

test('an infeasible week falls back on its own, without costing a later feasible week its guarantee', () => {
  // 4 employees (ids 1-4), perDay 2, two Mon+Tue weeks.
  // Week 1: employee 4 is already scheduled elsewhere both days, so only
  // 3 people are ever eligible for 2 slots/day across 2 days — needing 4
  // person-days from a pool where nobody can ethically work more than 1 of
  // the 2 days is impossible (max fair coverage 3 < 4 needed). That week
  // has to fall back to "just fill it," and someone works both days.
  // Week 2: all 4 are eligible, so 2 slots/day across 2 days (4
  // person-days total) exactly matches "everybody works exactly 1 of the
  // 2 days" — feasible, and should come out fully fair despite week 1
  // failing right before it.
  const result = solveSchedule({
    dates: ['2026-09-07', '2026-09-08', '2026-09-14', '2026-09-15'],
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

  const byDate = {};
  for (const e of result.entries) {
    (byDate[e.date] ??= []).push(e.employeeId);
  }

  // Week 1: someone necessarily works both offered days (infeasible, so
  // the guarantee was dropped for this week only).
  const week1Worked = new Map();
  for (const id of [...byDate['2026-09-07'], ...byDate['2026-09-08']]) {
    week1Worked.set(id, (week1Worked.get(id) || 0) + 1);
  }
  assert.ok([...week1Worked.values()].some((count) => count === 2), 'week 1 must be understaffed-fair, not guarantee-clean');

  // Week 2: every one of the 4 employees works exactly one of the two days.
  const week2Worked = new Map();
  for (const id of [...byDate['2026-09-14'], ...byDate['2026-09-15']]) {
    week2Worked.set(id, (week2Worked.get(id) || 0) + 1);
  }
  assert.equal(week2Worked.size, 4, 'all 4 employees get exactly one shift in week 2');
  assert.ok([...week2Worked.values()].every((count) => count === 1), 'nobody in week 2 works both days');

  assert.equal(result.restDaySkipped, 0);
  assert.equal(result.alreadyScheduledSkipped, 2); // employee 4, both days of week 1
});

test("buckets a week the way the roster page displays it (Mon-Sun), not Sun-Sat", () => {
  // Real bug caught before shipping the "Generate week" button: the web
  // Roster page's displayed week runs Monday-to-Sunday (mondayOf() in
  // SchedulePage.tsx). Bucketing Sun-Sat instead splits that one displayed
  // week into two pieces right at the Sunday — a 5-day piece (Mon-Thu+Sat,
  // Friday off) and the trailing Sunday alone in its own 1-day "week",
  // which can never satisfy "has a day off" (there's no other day to
  // check against) and silently falls back to unconstrained filling. Both
  // halves then have their own fallback, and whether the two fallbacks'
  // remainders happen to add up evenly is luck, not a guarantee — this
  // failed for 12 employees/cap 10 in exactly this shape before the fix.
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-12', '2026-09-13']; // Mon-Thu + Sat + Sun, Fri off
  const employees = Array.from({ length: 13 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, weeklyRestDay: null }));
  const cap = Math.floor((employees.length * 5) / 6); // 10

  const result = solveSchedule({ dates, cap, weekdayCount: 6, employees, alreadyScheduled: new Set() });
  assert.equal(result.entries.length, cap * 6);

  const counts = new Map();
  for (const e of result.entries) counts.set(e.employeeId, (counts.get(e.employeeId) || 0) + 1);
  // 60 shifts / 13 employees = 8 people at 5, 5 people at 4 (8*5 + 5*4 = 60)
  // — not a wide spread like the pre-fix bug could produce.
  const values = [...counts.values()];
  assert.ok(values.every((c) => c === 4 || c === 5), `expected only 4s and 5s, got ${values.join(',')}`);
  assert.equal(values.filter((c) => c === 5).length, 8);
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
  // days selected, 4 weeks — right at the edge of "barely possible while
  // everyone still gets a break" — took 30+ seconds of plain backtracking
  // per week before it was cut off. This must now come back in well under
  // a second by falling back to the guarantee-off pass once a week's
  // strict search burns through its step budget.
  const employees = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, weeklyRestDay: null }));
  const dates = [];
  let d = new Date('2026-09-07T00:00:00Z');
  for (let i = 0; i < 28; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const start = process.hrtime.bigint();
  const result = solveSchedule({
    dates,
    cap: 17,
    weekdayCount: 7,
    employees,
    alreadyScheduled: new Set(),
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  assert.ok(ms < 5000, `expected well under 5s, took ${ms.toFixed(0)}ms`);
  assert.equal(result.entries.length, 17 * 28);
});

// Backtracking CSP solver behind POST /schedule/suggest (routes/schedule.js).
// Pure function — no DB, no Express — so it's unit-tested directly
// (backend/test/scheduleSolver.test.js), the same pattern lib/csv.js uses.
//
// `dates` is always exactly ONE calendar week's worth of offered days —
// routes/schedule.js rejects any request spanning more than 7 days before
// this is ever called. That's a deliberate, user-directed scope cut (was:
// any range up to 90 days, solved as several independent weeks): a manager
// generates one week at a time, same as the Roster grid already displays
// one week at a time and "Copy Last Week" already only ever copies one
// week. Because of that cut, this file never needs to know which day
// starts a week, or split its input into buckets — "the week" simply *is*
// whatever `dates` it was given, in order. (An earlier version bucketed a
// possibly-multi-week `dates` array by calendar week, which is also where
// a Sun-Sat-vs-Mon-Sun mismatch with the web Roster page's own week
// display caused a real bug. That whole class of bug is gone now, not
// fixed — there's no bucketing left to get wrong.)
//
// The problem, as a CSP:
//   Variables   one per (date, slot#), slot# in 0..slotsNeeded(date)-1 —
//               "who works the s-th shift of this day." slotsNeeded(date)
//               is capped by both `cap` (perDay) and how many employees are
//               STATICALLY eligible that date (see below) — same as the old
//               greedy's `.slice(0, cap)`.
//   Domain      active employees in the pool, minus (a) whoever is pinned
//               off that weekday (users.weekly_rest_day) — fixed ahead of
//               time, independent of search decisions — and (b) whoever is
//               already assigned another slot the same date (all-different),
//               which DOES depend on search decisions.
//   Constraints (1) all-different within the same date; (2)/(3) — only once
//               the request offers >=2 distinct weekdays, see below — every
//               employee gets at least one unassigned OFFERED day, AND at
//               most `weekCap` shifts (ceil(this week's total shifts /
//               employee count) — the tightest ceiling that could still be
//               split evenly). A pin already counts as the day off;
//               otherwise the solver has to pick one. The ceiling exists
//               because the floor alone isn't real fairness: without it,
//               the "fewest shifts so far" tie-break can hand one employee
//               most of the week's slots while their running total is
//               still low — a real bug caught by testing against seeded
//               data, not just a hypothetical (see the "spike" test).
//
// Search: depth-first, dates in chronological order, candidates tried
// "fewest shifts assigned so far, lowest id first" — the exact tie-break
// the old greedy used, so wherever the day-off constraint never bites, the
// result is identical to before (see the parity tests). An empty domain is
// a genuine dead end: backtrack() undoes the previous slot's choice and
// tries the next candidate there — see the module's forced-backtrack test
// for a worked example of why this can't be done with a single forward
// pass.
//
// Why ">=2 distinct weekdays": with a single weekday selected (e.g. the
// manager is just topping up every Monday), there's no rotation to speak
// of — everyone who works, works "that one day" by definition of what was
// asked, and the rest of their week isn't managed by this request at all.
// Enforcing a day-off guarantee there would just starve every slot for no
// reason.
//
// First a STRICT pass runs (every slot must get a real employee, the
// day-off constraint is a hard wall); if the whole week is provably
// infeasible (e.g. `perDay` asks for more coverage than the pool can
// sustain while everyone still gets a break), it falls back to a pass with
// the day-off constraint turned off — which can be shown to never
// dead-end (every date's slotsNeeded is already capped at how many people
// are statically eligible that date, so there's always enough distinct
// people to go around).
//
// ponytail: plain DFS, no forward-checking/MRV/memoization. Fine at this
// project's scale (routes/schedule.js already caps a single request at
// one week and 500 generated entries, and a company's employee pool is
// small) — add smarter pruning only if this ever needs to run on much
// bigger inputs.

function weekdayOf(dateIso) {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

// dates: chronologically sorted ISO date strings — one week's worth of
//   offered days (routes/schedule.js enforces the 7-day cap).
// cap: max people needed per date (perDay, or employees.length if perDay
//   was omitted — see routes/schedule.js).
// weekdayCount: how many distinct weekdays the caller selected (the size
//   of the `weekdays` request param) — gates the day-off constraint.
// employees: [{ id, name, weeklyRestDay }], weeklyRestDay 0-6 or null.
// alreadyScheduled: Set of "employeeId|date" strings already booked
//   outside this request (an existing schedule_entry).
function solveSchedule({ dates, cap, weekdayCount, employees, alreadyScheduled }) {
  // ---- static eligibility + the two skip counters, unchanged from the old handler ----
  let restDaySkipped = 0;
  let alreadyScheduledSkipped = 0;
  const staticEligible = new Map(); // date -> employee[]
  for (const d of dates) {
    const weekday = weekdayOf(d);
    const onRestDay = employees.filter((e) => e.weeklyRestDay === weekday && !alreadyScheduled.has(`${e.id}|${d}`));
    restDaySkipped += onRestDay.length;
    const eligible = employees.filter((e) => e.weeklyRestDay !== weekday && !alreadyScheduled.has(`${e.id}|${d}`));
    alreadyScheduledSkipped += employees.length - onRestDay.length - eligible.length;
    staticEligible.set(d, eligible);
  }

  // ---- variables: one per (date, slot) ----
  const variablesByDate = new Map();
  const variables = [];
  for (const d of dates) {
    const slotsNeeded = Math.min(cap, staticEligible.get(d).length);
    const vs = [];
    for (let s = 0; s < slotsNeeded; s++) vs.push({ date: d, slot: s });
    variablesByDate.set(d, vs);
    variables.push(...vs);
  }

  const lastDate = dates[dates.length - 1];

  // ---- fair ceiling for the whole week ----
  // The day-off constraint alone only guarantees a FLOOR (>=1 unassigned
  // day). Nothing stops one employee from taking most of the week's slots
  // while they're "cheapest" (lowest running load) — this is the CEILING
  // too: if the week's slots were split perfectly evenly across the whole
  // pool, nobody should need more than this many.
  const weekCap = employees.length ? Math.ceil(variables.length / employees.length) : 0;

  // ---- search state ----
  const assignment = new Map(); // "date|slot" -> employeeId
  const load = new Map(employees.map((e) => [e.id, 0])); // the tie-break

  const assignedToday = (date, exceptSlot) => {
    const ids = new Set();
    for (const v of variablesByDate.get(date)) {
      if (v.slot === exceptSlot) continue;
      const id = assignment.get(`${v.date}|${v.slot}`);
      if (id != null) ids.add(id);
    }
    return ids;
  };

  const workedOnDate = (employeeId, date) =>
    variablesByDate.get(date).some((v) => assignment.get(`${v.date}|${v.slot}`) === employeeId);

  const hasADayOffSoFar = (employeeId, date) => dates.some((d2) => d2 !== date && !workedOnDate(employeeId, d2));

  // Only counts days strictly BEFORE `date` (already decided, since we
  // process chronologically) — unlike hasADayOffSoFar, this is checked on
  // every day, not just the last, so it can stop a spike before it
  // happens rather than only noticing on the last day.
  const workedSoFar = (employeeId, date) => {
    let count = 0;
    for (const d2 of dates) {
      if (d2 === date) break; // reached today — everything after is undecided
      if (workedOnDate(employeeId, d2)) count++;
    }
    return count;
  };

  const candidatesFor = (date, slot, enforceGuarantee) => {
    const busyToday = assignedToday(date, slot);
    let pool = staticEligible.get(date).filter((e) => !busyToday.has(e.id));
    if (enforceGuarantee) {
      pool = pool.filter((e) => workedSoFar(e.id, date) < weekCap);
      if (date === lastDate) {
        pool = pool.filter((e) => hasADayOffSoFar(e.id, date));
      }
    }
    return pool.slice().sort((a, b) => load.get(a.id) - load.get(b.id) || a.id - b.id);
  };

  // A request whose staffing ask sits right at the edge of what's still
  // possible while guaranteeing everyone a break (e.g. cap 17 of 20 people,
  // every day of the week) is heavily saturated — almost every combination
  // is a near-miss, which is exactly the shape that makes plain DFS
  // backtracking blow up combinatorially (measured: one such case didn't
  // finish in 30+ seconds). STEP_BUDGET bounds the strict attempt to a
  // fixed number of dead ends; running out counts the same as a
  // proven-infeasible week (backtrack() returning false) and falls
  // through to the guarantee-off pass, which can't dead-end. Legitimate
  // backtracking in realistic cases needs nowhere near this many attempts
  // (see scheduleSolver.test.js).
  const STEP_BUDGET = 3000;

  function backtrack(i, enforceGuarantee, budget) {
    if (i === variables.length) return true;
    if (budget.steps++ > STEP_BUDGET) return false;
    const { date, slot } = variables[i];
    const key = `${date}|${slot}`;
    for (const e of candidatesFor(date, slot, enforceGuarantee)) {
      assignment.set(key, e.id);
      load.set(e.id, load.get(e.id) + 1);
      if (backtrack(i + 1, enforceGuarantee, budget)) return true;
      assignment.delete(key);
      load.set(e.id, load.get(e.id) - 1);
    }
    return false; // every candidate dead-ends downstream — genuine backtrack
  }

  const enforceGuarantee = weekdayCount >= 2;
  const strictSucceeded = enforceGuarantee && backtrack(0, true, { steps: 0 });
  if (!strictSucceeded) backtrack(0, false, { steps: 0 }); // always succeeds — see module comment

  // ---- collect results, in date order ----
  const nameById = new Map(employees.map((e) => [e.id, e.name]));
  const entries = [];
  for (const d of dates) {
    for (const v of variablesByDate.get(d)) {
      const id = assignment.get(`${v.date}|${v.slot}`);
      if (id != null) entries.push({ employeeId: id, employeeName: nameById.get(id), date: d });
    }
  }

  return { entries, restDaySkipped, alreadyScheduledSkipped };
}

module.exports = { solveSchedule };

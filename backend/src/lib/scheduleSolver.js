// Backtracking CSP solver behind POST /schedule/suggest (routes/schedule.js).
// Pure function — no DB, no Express — so it's unit-tested directly
// (backend/test/scheduleSolver.test.js), the same pattern lib/csv.js uses.
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
//               employee gets at least one unassigned OFFERED day per
//               calendar week (Mon-Sun — matching how the web Roster page
//               itself displays a week, mondayOf() in SchedulePage.tsx;
//               bucketing any other way, e.g. Sun-Sat, can split that one
//               displayed week into two pieces at the Sun/Mon boundary,
//               silently breaking the whole guarantee — see the module's
//               "matches the roster page's own week" test), AND at most
//               weekCapOf(week) shifts
//               that same week (ceil(that week's total shifts / employee
//               count) — the tightest ceiling that could still be split
//               evenly). A pin already counts as the day off; otherwise the
//               solver has to pick one. The ceiling exists because the
//               floor alone isn't real fairness: without it, the "fewest
//               shifts so far" tie-break can hand one employee most of a
//               week's slots while their running total is still low, then
//               skip them for several weeks afterward while everyone else
//               catches up — a real bug caught by testing against seeded
//               data, not just a hypothetical (see the "spike" test).
//
// Search: depth-first, one calendar week at a time (in chronological
// order), dates within a week in chronological order, candidates tried
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
// Each calendar week is solved independently: first a STRICT pass (every
// slot must get a real employee, the day-off constraint is a hard wall);
// if that week is provably infeasible (e.g. `perDay` asks for more
// coverage than the pool can sustain while everyone still gets a break),
// only THAT week falls back to a pass with the day-off constraint turned
// off — which can be shown to never dead-end (every date's slotsNeeded is
// already capped at how many people are statically eligible that date, so
// there's always enough distinct people to go around). Scoping the
// fallback per week means one sparse/edge week never costs every other
// week its guarantee.
//
// ponytail: plain DFS, no forward-checking/MRV/memoization. Fine at this
// project's scale (routes/schedule.js already caps a single request at 500
// generated entries, and a company's employee pool is small) — add
// smarter pruning only if this ever needs to run on much bigger inputs.

function weekStartOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Mon->0, Tue->1, ..., Sun->6
  d.setUTCDate(d.getUTCDate() - daysSinceMonday); // back up to the Monday that starts this week
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateIso) {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

// dates: chronologically sorted ISO date strings (the offered days).
// cap: max people needed per date (perDay, or employees.length if perDay
//   was omitted — see routes/schedule.js).
// weekdayCount: how many distinct weekdays the caller selected (the size
//   of the `weekdays` request param) — gates the day-off constraint.
// employees: [{ id, name, weeklyRestDay }], weeklyRestDay 0-6 or null.
// alreadyScheduled: Set of "employeeId|date" strings already booked
//   outside this request (an existing schedule_entry).
// recentLoad: optional Map<employeeId, count> — a head start on the
//   fairness tie-break (e.g. shifts worked in the trailing 30 days before
//   `from`), same rotation intent the old handler had. Defaults to 0 for
//   everyone.
function solveSchedule({ dates, cap, weekdayCount, employees, alreadyScheduled, recentLoad }) {
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

  // ---- calendar-week buckets, for the day-off constraint ----
  const weekOf = new Map(); // date -> the Sunday that starts its week
  const datesInWeek = new Map(); // week-start -> ordered dates offered that week
  for (const d of dates) {
    const wk = weekStartOf(d);
    weekOf.set(d, wk);
    if (!datesInWeek.has(wk)) datesInWeek.set(wk, []);
    datesInWeek.get(wk).push(d);
  }
  const isLastOfferedDayOfWeek = (d) => {
    const week = datesInWeek.get(weekOf.get(d));
    return week[week.length - 1] === d;
  };

  // ---- variables: one per (date, slot) ----
  const variablesByDate = new Map();
  for (const d of dates) {
    const slotsNeeded = Math.min(cap, staticEligible.get(d).length);
    const vs = [];
    for (let s = 0; s < slotsNeeded; s++) vs.push({ date: d, slot: s });
    variablesByDate.set(d, vs);
  }

  // ---- per-week fair ceiling ----
  // The day-off constraint alone only guarantees a FLOOR (>=1 unassigned
  // day). Nothing stopped one employee from taking most of a week's other
  // slots while they're "cheapest" (lowest running load) — spiking their
  // count, which then swings the *next* several weeks the other way as the
  // tie-break avoids them until everyone else catches up. weekCapOf gives
  // each week a CEILING too: if this week's slots were split perfectly
  // evenly across the whole pool, nobody should need more than this many.
  const weekCapOf = new Map(); // week-start -> max shifts any one employee should take that week
  for (const [wk, weekDates] of datesInWeek) {
    const totalSlots = weekDates.reduce((sum, d) => sum + variablesByDate.get(d).length, 0);
    weekCapOf.set(wk, Math.ceil(totalSlots / employees.length));
  }

  // ---- search state, shared across every week we solve ----
  const assignment = new Map(); // "date|slot" -> employeeId
  const load = new Map(employees.map((e) => [e.id, recentLoad?.get(e.id) || 0])); // the tie-break

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

  const hasADayOffSoFarThisWeek = (employeeId, date) =>
    datesInWeek.get(weekOf.get(date)).some((d2) => d2 !== date && !workedOnDate(employeeId, d2));

  // Only counts days strictly BEFORE `date` in the week (already decided,
  // since we process chronologically) — unlike hasADayOffSoFarThisWeek,
  // this is checked on every day, not just the last, so it can stop a
  // spike before it happens rather than only noticing on the last day.
  const workedSoFarThisWeek = (employeeId, date) => {
    const week = datesInWeek.get(weekOf.get(date));
    let count = 0;
    for (const d2 of week) {
      if (d2 === date) break; // reached today — everything after is undecided
      if (workedOnDate(employeeId, d2)) count++;
    }
    return count;
  };

  const candidatesFor = (date, slot, enforceGuarantee) => {
    const busyToday = assignedToday(date, slot);
    let pool = staticEligible.get(date).filter((e) => !busyToday.has(e.id));
    if (enforceGuarantee) {
      const weekCap = weekCapOf.get(weekOf.get(date));
      pool = pool.filter((e) => workedSoFarThisWeek(e.id, date) < weekCap);
      if (isLastOfferedDayOfWeek(date)) {
        pool = pool.filter((e) => hasADayOffSoFarThisWeek(e.id, date));
      }
    }
    return pool.slice().sort((a, b) => load.get(a.id) - load.get(b.id) || a.id - b.id);
  };

  // A request whose staffing ask sits right at the edge of what's still
  // possible while guaranteeing everyone a break (e.g. cap 17 of 20 people,
  // every day of the week) is heavily saturated — almost every combination
  // is a near-miss, which is exactly the shape that makes plain DFS
  // backtracking blow up combinatorially (measured: one such case didn't
  // finish in 30+ seconds). STEP_BUDGET bounds a single week's strict
  // attempt to a fixed number of dead ends; running out counts the same as
  // a proven-infeasible week (line 160) and falls through to the
  // guarantee-off pass, which can't dead-end. Legitimate backtracking in
  // realistic cases needs nowhere near this many attempts (see
  // scheduleSolver.test.js).
  const STEP_BUDGET = 3000;

  function backtrack(vars, i, enforceGuarantee, budget) {
    if (i === vars.length) return true;
    if (budget.steps++ > STEP_BUDGET) return false;
    const { date, slot } = vars[i];
    const key = `${date}|${slot}`;
    for (const e of candidatesFor(date, slot, enforceGuarantee)) {
      assignment.set(key, e.id);
      load.set(e.id, load.get(e.id) + 1);
      if (backtrack(vars, i + 1, enforceGuarantee, budget)) return true;
      assignment.delete(key);
      load.set(e.id, load.get(e.id) - 1);
    }
    return false; // every candidate dead-ends downstream — genuine backtrack
  }

  const enforceGuarantee = weekdayCount >= 2;
  for (const week of datesInWeek.keys()) {
    const weekVars = datesInWeek.get(week).flatMap((d) => variablesByDate.get(d));
    if (enforceGuarantee && backtrack(weekVars, 0, true, { steps: 0 })) continue;
    backtrack(weekVars, 0, false, { steps: 0 }); // always succeeds — see module comment
  }

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

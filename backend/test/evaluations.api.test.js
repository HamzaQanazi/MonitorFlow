// API suite for the employee evaluation system (lib/evaluationMetrics.js,
// routes/evaluations.js, CLAUDE.md §13 supervisor-mandated). Drives one
// request through the fixture "Home Nursing Visit" workflow to completion so
// there's a real completed_count/avg_resolution_minutes for field1, then
// checks generation, scoring, listing, and Gate 1/2 permissions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  setup, stopServer, api, loginAll, fixtures, submitRequest,
} = require('../testlib/harness');

let tokens;
const periodStart = '2000-01-01';
const periodEnd = '2100-01-01'; // wide enough to always contain the fixture's completion

before(async () => {
  await setup('evaluations_api');
  tokens = await loginAll();

  const req = await submitRequest(tokens.resident, fixtures.serviceTypeId);
  const assign = await api('PATCH', `/requests/${req.id}/assign`, {
    token: tokens.root,
    body: { employeeId: fixtures.employeeIds.field1 },
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));

  const complete = await api('POST', `/requests/${req.id}/transitions`, {
    token: tokens.field1,
    body: { transition_key: 'complete', form: { notes: 'All good' }, expected_status: 'scheduled' },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));

  const confirm = await api('POST', `/requests/${req.id}/transitions`, {
    token: tokens.resident,
    body: { transition_key: 'confirm', expected_status: 'visited' },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
});

after(() => stopServer());

test('non-oversight employee cannot generate → 403', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.field1,
    body: { employeeId: fixtures.employeeIds.field1, periodStart, periodEnd },
  });
  assert.equal(res.status, 403);
});

test('cross-department generate → 404 (Gate 2)', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.head2,
    body: { employeeId: fixtures.employeeIds.field1, periodStart, periodEnd },
  });
  assert.equal(res.status, 404);
});

test('missing/invalid period → 422', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { employeeId: fixtures.employeeIds.field1, periodStart: '2100-01-01', periodEnd: '2000-01-01' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.errors.periodEnd);
});

let evaluationId;

test('employeeId + departmentId together → 422', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: {
      employeeId: fixtures.employeeIds.field1,
      departmentId: fixtures.departmentId,
      periodStart,
      periodEnd,
    },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.errors.departmentId);
});

test('department manager generates an evaluation for their own employee → 201', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { employeeId: fixtures.employeeIds.field1, periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.evaluations.length, 1);
  const [evaluation] = res.body.evaluations;
  assert.equal(evaluation.employeeId, fixtures.employeeIds.field1);
  assert.ok(evaluation.score >= 0 && evaluation.score <= 100, `score out of range: ${evaluation.score}`);
  // field1 completed the one request in-period — completedCount must reflect it.
  assert.equal(evaluation.breakdown.metrics.completedCount, 1);
  assert.ok(evaluation.breakdown.metrics.avgResolutionMinutes >= 0);
  // Comparison pool = field1's STAFF department peers only (field2) plus
  // field1 themself — root is excluded, oversight (managerLevelId, holds
  // view_all) doesn't work the queue and isn't evaluated.
  assert.equal(evaluation.breakdown.poolSize, 2);
  evaluationId = evaluation.id;
});

test('generating for an oversight employee (root, holds view_all) → 422', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.admin,
    body: { employeeId: fixtures.employeeIds.root, periodStart, periodEnd },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.errors.employeeId);
});

test('generate for a whole department → excludes the oversight employee (root)', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { departmentId: fixtures.departmentId, periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ids = res.body.evaluations.map((e) => e.employeeId).sort((a, b) => a - b);
  assert.deepEqual(ids, [fixtures.employeeIds.field1, fixtures.employeeIds.field2].sort((a, b) => a - b));
  assert.ok(!ids.includes(fixtures.employeeIds.root));
  // Sorted best-first.
  const scores = res.body.evaluations.map((e) => e.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
});

test('cross-department departmentId → 404', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { departmentId: fixtures.otherDepartmentId, periodStart, periodEnd },
  });
  assert.equal(res.status, 404);
});

test('no employeeId/departmentId: department manager generates for their own department only', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // root's reachable scope is just their own department (view_all, no
  // view_all_company) — same two STAFF employees as the explicit-departmentId
  // case (root themself, oversight, is excluded).
  assert.equal(res.body.evaluations.length, 2);
});

test('GET /evaluations?departmentId= — leaderboard, latest per employee, excludes oversight', async () => {
  const res = await api('GET', `/evaluations?departmentId=${fixtures.departmentId}`, { token: tokens.root });
  assert.equal(res.status, 200);
  assert.equal(res.body.evaluations.length, 2);
  assert.ok(!res.body.evaluations.some((e) => e.employeeId === fixtures.employeeIds.root));
  const scores = res.body.evaluations.map((e) => e.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
});

test('GET /evaluations with no params — leaderboard over the actor\'s whole scope', async () => {
  const res = await api('GET', '/evaluations', { token: tokens.root });
  assert.equal(res.status, 200);
  assert.equal(res.body.evaluations.length, 2);
});

test('head2 (a different department) never sees field1 in a scope-wide leaderboard', async () => {
  const res = await api('GET', '/evaluations', { token: tokens.head2 });
  assert.equal(res.status, 200);
  assert.ok(!res.body.evaluations.some((e) => e.employeeId === fixtures.employeeIds.field1));
});

test('GET /evaluations?employeeId= lists full history, newest first', async () => {
  const res = await api('GET', `/evaluations?employeeId=${fixtures.employeeIds.field1}`, { token: tokens.root });
  assert.equal(res.status, 200);
  // field1 was generated 3 times by this point: the single-employee call,
  // the whole-department call, and the no-params (own-scope) call.
  assert.equal(res.body.evaluations.length, 3);
  assert.ok(res.body.evaluations.some((e) => e.id === evaluationId));
});

test('GET /evaluations/:id → 200 in scope, 404 out of scope', async () => {
  const inScope = await api('GET', `/evaluations/${evaluationId}`, { token: tokens.root });
  assert.equal(inScope.status, 200);

  const outOfScope = await api('GET', `/evaluations/${evaluationId}`, { token: tokens.head2 });
  assert.equal(outOfScope.status, 404);
});

test('admin can generate/view across every department', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.admin,
    body: { employeeId: fixtures.employeeIds.field1, periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('solo STAFF department (no active peers): self-vs-prior-period, not cross-department', async () => {
  // head2's department has only head2 in it, and head2 is oversight
  // (excluded) — so a genuine "solo staff member" needs its own fresh
  // department + hire, done here rather than in the shared fixture.
  const branches = await api('GET', '/branches', { token: tokens.admin });
  assert.equal(branches.status, 200, JSON.stringify(branches.body));
  const dept = await api('POST', '/departments', {
    token: tokens.admin,
    body: { name: { en: 'Solo Dept', ar: 'دائرة فردية' }, branchId: branches.body.branches[0].id },
  });
  assert.equal(dept.status, 201, JSON.stringify(dept.body));

  const solo = await api('POST', '/employees', {
    token: tokens.admin,
    body: {
      firstName: 'Solo',
      lastName: 'Staffer',
      email: 'solo.staffer@fixture.test',
      phone: '0590000000',
      birthdate: '1995-01-01',
      gender: 'female',
      workerType: 'full_time',
      departmentId: dept.body.departmentId,
      levelId: fixtures.levelIds.staff,
    },
  });
  assert.equal(solo.status, 201, JSON.stringify(solo.body));

  const res = await api('POST', '/evaluations/generate', {
    token: tokens.admin,
    body: { employeeId: solo.body.employee.id, periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [evaluation] = res.body.evaluations;
  assert.equal(evaluation.breakdown.poolSize, 2);
  assert.equal(evaluation.breakdown.comparedTo, 'self');
});

test('idle period (zero completions) scores near the bottom, not a neutral ~40-50', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { employeeId: fixtures.employeeIds.field2, periodStart: '2099-01-01', periodEnd: '2099-02-01' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [evaluation] = res.body.evaluations;
  assert.equal(evaluation.breakdown.metrics.completedCount, 0);
  assert.ok(evaluation.score <= 15, `expected a low idle score, got ${evaluation.score}`);
});

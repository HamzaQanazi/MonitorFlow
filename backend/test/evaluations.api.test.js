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
  // Comparison pool = field1's whole department (root, field1, field2).
  assert.equal(evaluation.breakdown.poolSize, 3);
  evaluationId = evaluation.id;
});

test('generate for a whole department → one evaluation per active employee', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.root,
    body: { departmentId: fixtures.departmentId, periodStart, periodEnd },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ids = res.body.evaluations.map((e) => e.employeeId).sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    [fixtures.employeeIds.root, fixtures.employeeIds.field1, fixtures.employeeIds.field2].sort((a, b) => a - b)
  );
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
  // view_all_company) — same three employees as the explicit-departmentId case.
  assert.equal(res.body.evaluations.length, 3);
});

test('GET /evaluations?departmentId= — leaderboard, latest per employee', async () => {
  const res = await api('GET', `/evaluations?departmentId=${fixtures.departmentId}`, { token: tokens.root });
  assert.equal(res.status, 200);
  assert.equal(res.body.evaluations.length, 3);
  const scores = res.body.evaluations.map((e) => e.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
});

test('GET /evaluations with no params — leaderboard over the actor\'s whole scope', async () => {
  const res = await api('GET', '/evaluations', { token: tokens.root });
  assert.equal(res.status, 200);
  assert.equal(res.body.evaluations.length, 3);
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

test('solo department (head2, no active peers): self-vs-prior-period, not cross-department', async () => {
  const res = await api('POST', '/evaluations/generate', {
    token: tokens.head2,
    body: { employeeId: fixtures.employeeIds.head2, periodStart, periodEnd },
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

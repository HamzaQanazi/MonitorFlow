// Harness for the API/permission suite (CLAUDE.md §14).
//
// Lives outside test/ on purpose: `node --test` executes every .js file in a
// directory named `test`, so a helper placed there would be run as a suite.
//
// The server is spawned as a real subprocess rather than imported, because
// src/index.js calls app.listen() and starts the escalation interval at import
// time. Spawning also means the suite exercises the real wire — JSON limits,
// the 404 fallthrough, the error middleware — instead of a hand-built app.
// No production file changes are needed for any of this.
require('dotenv').config();
const { spawn } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const BACKEND = path.join(__dirname, '..');

// `node --test` runs test FILES in parallel, so each suite needs its own
// database and port or two suites would drop each other's data mid-run and
// fight over the same listener. Both are derived from the suite name passed to
// setup(), so adding a suite needs no bookkeeping here.
let TEST_DB = 'monitorflow_test';
let PORT = Number(process.env.TEST_PORT || 3101);
let BASE = `http://127.0.0.1:${PORT}/api/v1`;

function useSuite(name) {
  if (!name) return;
  TEST_DB = `monitorflow_test_${name}`;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 100;
  PORT = 3100 + h;
  BASE = `http://127.0.0.1:${PORT}/api/v1`;
}

// The dev DATABASE_URL with the database swapped. Everything else (host, user,
// password) is reused, so the suite needs no extra configuration.
function testDbUrl(db = TEST_DB) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

async function adminQuery(sql) {
  const c = new Client({ connectionString: testDbUrl('postgres') });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

// Same as adminQuery, but against the suite's own test DB — for fixture setup
// that has no API surface at all (level-capability grants, id lookups), never
// for anything a real deployment could do through the API.
async function query(sql, params) {
  const c = new Client({ connectionString: testDbUrl() });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    // No shell: spawning through cmd.exe on Windows would make the child a
    // shell wrapper, and kill() would then terminate the wrapper while the real
    // node process kept running (and kept this process's pipes open forever).
    const p = spawn(cmd, args, { cwd: BACKEND, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed:\n${out}`))
    );
  });
}

// Drop and rebuild the test database, then migrate and seed it. Dropping first
// makes every run start from the same canonical state, so tests cannot leak
// into each other through the database.
async function resetTestDb() {
  await adminQuery(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`
  );
  await adminQuery(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await adminQuery(`CREATE DATABASE ${TEST_DB}`);
  const env = { DATABASE_URL: testDbUrl() };
  await run('node', ['src/migrate.js'], env);
  await run('node', ['src/seed.js'], env);
}

let server;

async function startServer() {
  server = spawn('node', ['src/index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      DATABASE_URL: testDbUrl(),
      PORT: String(PORT),
      // Documented test hook (src/index.js): no background sweep firing
      // notifications underneath assertions.
      ESCALATION_SWEEP_MS: '0',
      // Force lib/mailer.js's "log instead of send" fallback regardless of
      // what a developer's real .env has configured — every fixture hire
      // triggers a credentials email, and the suite would otherwise fire
      // real SMTP sends on every run (slow, rate-limited by the provider,
      // and not what "test environment" should mean).
      SMTP_HOST: '',
    },
    // See run(): no shell, or kill() cannot reach the server process.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Ready when an unauthenticated request is refused — that proves the routes
  // and the auth middleware are both mounted.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/services`);
      if (r.status === 401) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start within 20s');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stopServer() {
  if (!server) return;
  server.kill();
  server = null;
}

// Thin fetch wrapper. Returns { status, body } rather than throwing, because
// these tests assert on status codes far more often than on payloads.
async function api(method, pathname, { token, body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const SEED_PASSWORD = 'Password123!';

// v7's seed.js provisions the Owner with these — see backend/src/seed.js.
// Overridable the same way seed.js's own defaults are, via the same env vars.
const OWNER_EMAIL = (process.env.SEED_OWNER_EMAIL || 'owner@company.com').toLowerCase();
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD || 'Password123!';

// Seeded/fixture logins, by the role each plays in the permission matrix.
// Populated by buildFixtures() during setup() — empty until then. Employees
// sign in with their generated company email (lib/employeeEmail.js); `admin`
// and `resident` sign in with a plain email.
const WHO = {};

// Real per-role password, when it differs from SEED_PASSWORD. POST /employees
// no longer accepts an admin-typed password (CLAUDE.md §13 — credentials are
// always server-generated and email-delivered) — buildFixtures()'s hire()
// captures each employee's real tempPassword here. `admin` (seed.js) and
// `resident` (POST /auth/register, unaffected by that change) still use
// SEED_PASSWORD and never get an entry.
const PASSWORDS = {};

// Ids and other identifiers a test might need beyond a login — also populated
// by buildFixtures().
const fixtures = {};

async function login(identifier, password = SEED_PASSWORD) {
  const { status, body } = await api('POST', '/auth/login', {
    body: { identifier, password },
  });
  if (status !== 200) throw new Error(`login ${identifier} failed: ${status}`);
  return body.token;
}

// Log in everyone in WHO once; tests index into the result by role name.
async function loginAll() {
  const tokens = {};
  for (const [role, identifier] of Object.entries(WHO)) {
    tokens[role] = await login(identifier, PASSWORDS[role] || SEED_PASSWORD);
  }
  return tokens;
}

// The smallest form_response that satisfies every required field of a stored
// field_schema. Derived from the schema at runtime — no field id is ever named
// here, so it works for any seeded sector. A negative test starts from this and
// changes exactly one thing, so its 422 can only come from that change.
function formPayload(fields) {
  const out = {};
  for (const f of fields) {
    if (!f.required) continue;
    switch (f.type) {
      case 'number': out[f.id] = f.min ?? 1; break;
      case 'date': out[f.id] = '2026-07-18'; break;
      case 'checkbox': out[f.id] = true; break;
      case 'dropdown':
      case 'radio': out[f.id] = f.options[0].value; break;
      case 'location': out[f.id] = { lat: 32.22, lng: 35.26 }; break;
      case 'photo': out[f.id] = null; break; // a test that needs a real one sets it
      default: out[f.id] = 'x'.repeat(Math.max(f.min ?? 1, 1));
    }
  }
  return out;
}

// Submit a request as a user and return it. Tests that need a request in a
// KNOWN starting status make one rather than hunting the seeded queue, whose
// statuses earlier tests have already moved on.
async function submitRequest(token, serviceTypeId) {
  const form = await api('GET', `/services/${serviceTypeId}/forms/request`, { token });
  if (form.status !== 200) throw new Error(`form ${serviceTypeId}: ${form.status}`);
  const res = await api('POST', '/requests', {
    token,
    body: { serviceTypeId, formResponse: formPayload(form.body.fields) },
  });
  if (res.status !== 201) throw new Error(`submit ${serviceTypeId}: ${res.status}`);
  return res.body.request;
}

// v7's seed (backend/src/seed.js) provisions a bare Owner + one empty company
// — no employees beyond the Owner, no departments beyond a "General" stub, no
// service types/forms/workflows (the old municipal company-config.js seed is
// removed, CLAUDE.md §13). Everything a test needs beyond that is built here,
// through the real API wherever one exists, so the suite exercises the same
// validated code paths a real deployment would (onboarding, hiring, the Add
// Service builder) rather than hand-inserted rows. Runs once per setup().
async function buildFixtures() {
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
  WHO.admin = OWNER_EMAIL;

  // Onboarding first — POST /employees and POST /services both 422/403 on an
  // un-onboarded company. `plan: 'enterprise'` keeps the seat cap out of the
  // way for every suite except the one that deliberately tests it (which
  // lowers its own company's plan directly, see employees.api.test.js).
  const onboard = await api('PATCH', '/company/onboarding', {
    token: ownerToken,
    body: {
      name: { en: 'Fixture Co', ar: 'شركة تجريبية' },
      address: { en: '1 Test St', ar: 'شارع الاختبار 1' },
      phone: '0590000000',
      emailDomain: 'fixture.test',
      employeeRange: '11-30',
      industry: 'field_services',
      branches: [{ en: 'Main', ar: 'الرئيسي' }],
      features: ['time_clock'],
      plan: 'enterprise',
    },
  });
  if (onboard.status !== 200) {
    throw new Error(`fixture onboarding failed: ${onboard.status} ${JSON.stringify(onboard.body)}`);
  }

  // No level-authoring endpoint exists post-pivot (CLAUDE.md §12 — Gate-1
  // level grants are seed-time only). The seeded "Manager" level deliberately
  // holds only view_all/manage_employees/override (seed.js's product
  // default); the permission suite needs one role that holds every
  // in-scope capability to drive full happy paths, so this grants the rest
  // directly — EXCEPT view_all_company, which is deliberately excluded: it
  // widens Gate 2 itself (company-wide scope, scope.js), not an in-scope
  // action, so blanket-granting it here would silently collapse the
  // root/head2 two-department fixture below into one shared scope and break
  // every cross-department-refusal test. A level that actually holds
  // view_all_company gets built explicitly where it's tested (see
  // employees.api.test.js). Test-DB-only — resetTestDb() rebuilds from a
  // clean seed every run, so this never touches what a real deployment ships.
  const { rows: levels } = await query(`SELECT id, name->>'en' AS name FROM employee_level`);
  const managerLevelId = levels.find((l) => l.name === 'Manager').id;
  const staffLevelId = levels.find((l) => l.name === 'Staff').id;
  await query(
    `INSERT INTO level_capability (level_id, capability_key)
     SELECT $1, key FROM capability
     WHERE key <> 'view_all_company'
       AND key NOT IN (SELECT capability_key FROM level_capability WHERE level_id = $1)`,
    [managerLevelId]
  );

  const { rows: depts } = await query(`SELECT id FROM department LIMIT 1`);
  const departmentId = depts[0].id;
  const { rows: branches } = await query(`SELECT id FROM branch LIMIT 1`);
  // Gate 2 is flat department membership (re-scoped, user-directed — no more
  // manager tree), so "two independent subtrees" now means two separate
  // departments: root/field1/field2 share one, head2 gets their own, so a
  // cross-subtree-refusal test still has an actor who is genuinely outside
  // root's reach.
  const otherDept = await api('POST', '/departments', {
    token: ownerToken,
    body: { name: { en: 'Other Dept', ar: 'دائرة أخرى' }, branchId: branches[0].id },
  });
  if (otherDept.status !== 201) throw new Error(`fixture other department: ${otherDept.status} ${JSON.stringify(otherDept.body)}`);
  const otherDepartmentId = otherDept.body.departmentId;

  // Phone/birthdate/gender/workerType are required at creation now (CLAUDE.md
  // §13) — every fixture hire needs a value, so a fixed one covers all of them.
  async function hire(firstName, lastName, { levelId = null, deptId = departmentId } = {}) {
    const res = await api('POST', '/employees', {
      token: ownerToken,
      body: {
        firstName,
        lastName,
        email: `${firstName}.${lastName}@fixture.test`.toLowerCase(),
        phone: '0590000000',
        birthdate: '1995-01-01',
        gender: 'female',
        workerType: 'full_time',
        departmentId: deptId,
        levelId,
      },
    });
    if (res.status !== 201) throw new Error(`hire ${firstName}: ${res.status} ${JSON.stringify(res.body)}`);
    // The server always generates the password now (never admin-typed) —
    // callers that need to log this employee in read .tempPassword.
    return { ...res.body.employee, tempPassword: res.body.tempPassword };
  }

  // Two independent subtrees (root/field1/field2 vs head2 alone), mirroring
  // the shape a cross-subtree-refusal test needs: an actor in one tree must
  // never reach a resource owned by the other.
  const root = await hire('Root', 'Manager', { levelId: managerLevelId });
  const head2 = await hire('Head', 'Second', { levelId: managerLevelId, deptId: otherDepartmentId });
  const field1 = await hire('Field', 'One', { levelId: staffLevelId });
  const field2 = await hire('Field', 'Two', { levelId: staffLevelId });

  // A department with no head can't attribute an auto-assign audit row
  // (2026-09-04 — service_type.owner_id is gone, so auto-assign falls back
  // to the service's own department head instead) — every service-scoping
  // test that exercises real auto-assignment needs one, so both fixture
  // departments get theirs set to the manager already hired into them.
  const rootHead = await api('PATCH', `/departments/${departmentId}/head`, {
    token: ownerToken,
    body: { headEmployeeId: root.id },
  });
  if (rootHead.status !== 204) throw new Error(`fixture department head: ${rootHead.status} ${JSON.stringify(rootHead.body)}`);
  const otherHead = await api('PATCH', `/departments/${otherDepartmentId}/head`, {
    token: ownerToken,
    body: { headEmployeeId: head2.id },
  });
  if (otherHead.status !== 204) throw new Error(`fixture other department head: ${otherHead.status} ${JSON.stringify(otherHead.body)}`);

  WHO.root = root.loginIdentifier;
  WHO.head2 = head2.loginIdentifier;
  WHO.field1 = field1.loginIdentifier;
  WHO.field2 = field2.loginIdentifier;
  PASSWORDS.root = root.tempPassword;
  PASSWORDS.head2 = head2.tempPassword;
  PASSWORDS.field1 = field1.tempPassword;
  PASSWORDS.field2 = field2.tempPassword;

  fixtures.departmentId = departmentId;
  fixtures.otherDepartmentId = otherDepartmentId;
  fixtures.levelIds = { manager: managerLevelId, staff: staffLevelId };
  fixtures.employeeIds = { root: root.id, head2: head2.id, field1: field1.id, field2: field2.id };

  // External submitter (the old `resident`). /auth/register creates a `user`
  // account keyed by email (routes/auth.js) — no login_identifier field.
  const RESIDENT_EMAIL = 'resident@fixture.test';
  const reg = await api('POST', '/auth/register', {
    body: { name: 'Resident Fixture', email: RESIDENT_EMAIL, password: SEED_PASSWORD },
  });
  if (reg.status !== 201) throw new Error(`register resident: ${reg.status} ${JSON.stringify(reg.body)}`);
  WHO.resident = RESIDENT_EMAIL;

  // One fixture service — a real form + workflow, adapted from
  // docs/demo/home_nursing.json (a shape already proven valid against the
  // seed-time validators) into the POST /services payload. Exercises a
  // capability-gated transition (schedule), two actor-gated transitions
  // (cancel/confirm as requester, complete as assignee), a required
  // completion form, and an SLA'd status — enough surface for the requests/
  // tasks suites without trying to replicate all three old municipal
  // workflow shapes.
  const svc = await api('POST', '/services', {
    token: ownerToken,
    body: {
      name: { en: 'Home Nursing Visit', ar: 'زيارة تمريض منزلي' },
      departmentId,
      defaultPriority: 'medium',
      acceptsExternalUsers: true,
      acceptsEmployeeSubmitters: false,
      featureKey: null,
      ownerId: root.id,
      requestFields: [
        { id: 'patient_name', label: { en: 'Patient Name', ar: 'اسم المريض' }, type: 'text', required: true },
        {
          id: 'care_type',
          label: { en: 'Care Needed', ar: 'نوع الرعاية المطلوبة' },
          type: 'dropdown',
          required: true,
          options: [
            { value: 'wound', label: { en: 'Wound Care', ar: 'عناية بالجروح' } },
            { value: 'vitals', label: { en: 'Vitals Check', ar: 'فحص العلامات الحيوية' } },
          ],
        },
        { id: 'address', label: { en: 'Visit Address', ar: 'عنوان الزيارة' }, type: 'location', required: true },
      ],
      completionFields: [
        { id: 'notes', label: { en: 'Visit Notes', ar: 'ملاحظات الزيارة' }, type: 'multiline', required: true },
      ],
      statuses: [
        { key: 'requested', label: { en: 'Requested', ar: 'مطلوب' }, is_initial: true, is_terminal: false, sla_minutes: 240 },
        { key: 'scheduled', label: { en: 'Scheduled', ar: 'مجدول' }, is_initial: false, is_terminal: false, sla_minutes: 1440 },
        { key: 'visited', label: { en: 'Visit Complete', ar: 'اكتملت الزيارة' }, is_initial: false, is_terminal: false },
        { key: 'confirmed', label: { en: 'Confirmed', ar: 'مؤكد' }, is_initial: false, is_terminal: true },
        { key: 'cancelled', label: { en: 'Cancelled', ar: 'ملغي' }, is_initial: false, is_terminal: true },
      ],
      transitions: [
        {
          key: 'schedule', from: 'requested', to: 'scheduled',
          label: { en: 'Schedule Visit', ar: 'جدولة الزيارة' },
          required_capability: 'assign', actor: null, requires_note: false,
          notify: ['created_by', 'assigned_to'],
        },
        {
          key: 'cancel', from: 'requested', to: 'cancelled',
          label: { en: 'Cancel', ar: 'إلغاء' },
          required_capability: null, actor: 'requester', requires_note: true,
          notify: ['created_by'],
        },
        {
          key: 'complete', from: 'scheduled', to: 'visited',
          label: { en: 'Complete Visit', ar: 'إنهاء الزيارة' },
          required_capability: null, actor: 'assignee', required_form_key: 'completion', requires_note: false,
          notify: ['created_by'],
        },
        {
          key: 'confirm', from: 'visited', to: 'confirmed',
          label: { en: 'Confirm', ar: 'تأكيد' },
          required_capability: null, actor: 'requester', requires_note: false,
          notify: [],
        },
      ],
    },
  });
  if (svc.status !== 201) throw new Error(`fixture service failed: ${svc.status} ${JSON.stringify(svc.body)}`);
  fixtures.serviceTypeId = svc.body.serviceTypeId;
}

// One-shot setup for a test file: canonical database + running server +
// fixture org/service built through the real API. `name` isolates this
// suite's database and port from every other suite.
async function setup(name) {
  useSuite(name);
  await resetTestDb();
  await startServer();
  await buildFixtures();
}

// BASE is rebound by useSuite() during setup(), so it can only be read through
// a function — a destructured copy taken at require time is the stale default.
const apiUrl = (pathname) => `${BASE}${pathname}`;

module.exports = {
  setup, stopServer, api, apiUrl, login, loginAll, WHO, PASSWORDS, fixtures, SEED_PASSWORD, testDbUrl, query,
  formPayload, submitRequest,
};

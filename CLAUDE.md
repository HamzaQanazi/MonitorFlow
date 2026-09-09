# MonitorFlow — Project Context for Claude Code

This file is the **single source of truth** for this project. Read it before
implementing anything. These are **invariants**, not preferences — design
skills, style guides, and `DESIGN.md` are subordinate to this file. If a request
contradicts a rule here, **flag the contradiction** instead of silently
resolving it either way.

**Spec version: v7 (current) — pivot in progress.** v7 begins the pivot from a
multi-sector, config-API-driven platform to a **single-company workforce app
provisioned with an Owner who runs a first-login onboarding wizard**. What has
already shipped in v7: the old JSON **config API and outbound webhooks are
removed**; the municipality seed (`company-config.js`) is gone, replaced by a seed
that provisions **one empty company + one Owner** (§9); a `company`/`branch` schema
and the **onboarding wizard** (backend + React) are in.

**The operational engine underneath is unchanged and still live** — the dynamic
form engine, the dynamic workflow engine, the two-gate permission model, requests/
tasks/audit. Invariants I2–I10 (§2) still hold for that layer. The workforce
feature modules the wizard lets an Owner *select* (`features` on `company`) have
since **shipped**: Time Clock, Schedule, Checklists, Knowledge Base, Events —
backend routes + migrations, web pages, and mobile screens for each (§11).
Directory and Training & Onboarding shipped the same way but were **removed
2026-08-21** (§13 — deliberate, low product/thesis value for the effort).
Where this file still describes the old config-driven surface, treat
§1/§9/§13 as the current truth and flag any conflict.

Supersedes the old ER v3 / API v2 spec. The API contract lives in `openapi.yaml`
(§12); note it has **drifted** from the code during the pivot and is being
reconciled (see §12).

---

## 1. What this project is

MonitorFlow is a **single-company workforce and field-operations platform**. Two
mobile apps (User, Employee — Flutter) and one web dashboard (React) share one
backend and one database. **One deployment = one company** (§13).

**How a company comes online (v7):** the buyer is **provisioned an Owner account
at purchase** (seed/CLI — no self-registration for the Owner). On first login the
Owner runs the **"Customize your app in 1 minute" onboarding wizard** (§9): company
info, industry, branches, the **feature modules** they want, branding,
contact. That fills the one `company` row and flips `onboarding_completed`; from
then on the console is live and staff are added through the employee flow.

**The engine underneath stays configuration-driven and generic** — no file, table,
route, or component is specific to any one industry (I1 still holds). It runs on two
engines:

- **Dynamic form engine** — forms render from a `field_schema` JSON stored per
  service type (`validateFormResponse.js`, `formSchema.js`, the Flutter
  renderer). No per-sector form code.
- **Dynamic workflow engine** — status transitions validate against a
  `WORKFLOW_DEFINITION` (statuses + capability/actor-gated transitions) stored
  per service type (`workflowEngine.js`). No status key ever hardcoded in app
  code — code reasons about `is_terminal`, `required_capability`, and `actor`
  only (§8).

The onboarding **feature selections** (`time_clock`, `schedule`, …) are stored on
the company as data; the feature modules themselves have shipped (§11) — the
selection currently doesn't gate access to a module's routes/pages (documented
gap, §15). The catalogue the wizard offers — employee ranges, industries + sub-industries,
features — lives in one backend file (`lib/onboardingOptions.js`), the single
source of truth the wizard fetches (thin client, I4).

**Context:** graduation project, 2 students, built with heavy Claude Code
assistance. The MVP shipped, the Operiva migration completed, and v7 began the
workforce pivot. Do not re-add anything from the "removed" list (§13) without a
deliberate, explicit decision by both students.

---

## 2. THE INVARIANTS — violating one invalidates the thesis, it is not "a bug"

### I1. Nothing is service-specific. Ever.
No file, class, table, route, component, or `if` may mention a specific sector.
```
BANNED                            CORRECT
/api/maintenance/requests         /api/requests?serviceTypeId=…
class MaintenanceRequest {}        class Request {}
if (service === 'pothole')         (drive it from config)
PermitForm.tsx                     DynamicForm.tsx
```
No `if (industry === 'healthcare')` branch may ever exist. The onboarding
catalogue (`lib/onboardingOptions.js`) *lists* industries and features as **data**
— a picklist, like a country dropdown — and the feature list is identical for every
industry (product rule). Listing an option is fine; branching behaviour on it is
the violation.

### I2. "Monitor" is not a role. Exactly three account kinds.
```
admin     configures the platform. OUTSIDE every department. Seed/admin-created.
employee  operational. Belongs to a department. Created by an admin/oversight employee.
user      external submitter. OPTIONAL per service. Self-registers.
```
An overseer ("monitor") is just an **employee at a level that holds oversight
capabilities**. Never write `role === 'monitor'`, `isManager(user)`, or a
`MonitorGuard`. Authority comes from the two gates below, never a hardcoded role.

### I3. The two-gate permission model — check BOTH, server-side, every time.
```
GATE 1 (actions)  Does the actor's LEVEL grant the required capability?
                  → level_capability table (lib/capabilities.js, requireCapability)
GATE 2 (scope)    Is the target inside the actor's DEPARTMENT (or, holding
                  view_all_company, inside the whole company)?
                  → flat department_id match (lib/scope.js, ownerInScope)
```
Both gates, on every guarded action, on the server. A client showing a button is
**not** authorisation. Assignment is therefore **department-only** — you assign to
anyone in your own department, never across departments. **Re-scoped, user-
directed: the multi-level manager tree (`users.manager_id`, arbitrary-depth
recursive CTE) is gone.** Gate 2 is flat: an employee's scope is exactly their
own department's members (self included), full stop — no root employee, no
"reaches the whole organisation by sitting at the top" special case for anyone
but the admin (who has no department and sees the whole company by construction,
I2). `department.head_user_id` is display metadata, not a scope mechanism: every
`view_all` holder in a department has equal Gate-2 reach over it, head or not.
**One deliberate, capability-driven exception (added 2026-09-04, user-
directed): `view_all_company`.** A level holding it makes its employees'
Gate-2 scope the whole company instead of their own department — an
*operational* path to company-wide reach (a General Manager who still works
requests/tasks like any employee) distinct from the admin's role-based one
(who holds no capabilities and doesn't operate the queue, I2). It's a real
Gate-1 grant like any other in `lib/capabilities.js` — never a hardcoded
role check — and it's orthogonal to every other capability the same way
Gate 1 and Gate 2 are orthogonal to each other: `view_all_company` decides
**where** an employee's authority reaches, `view_all` decides **what** they
can see once there. Holding only `view_all_company` still leaves Gate 1
limiting an employee to their own resources, just across a much bigger
scope; the two are typically granted together for real company-wide
oversight. See `lib/scope.js`.

### I4. Clients are THIN RENDERERS.
Frontends never hardcode a field name, a status key, or a role.
```
To draw a form   GET the form definition → render each field by its `type`
To draw buttons  GET /requests/{id}/transitions → render exactly what returns
```
`/requests/{id}/transitions` returns only what is legal from the current status
**and** permitted to this caller — both gates already applied. Render that list,
nothing more. One defensive rule in the renderer: unknown field `type` → disabled
"unsupported field" placeholder; block submission if it is `required`; never
crash.

### I5. Every user-facing label is bilingual. No bare strings.
```ts
type LocalizedText = { en: string; ar: string };   // both keys REQUIRED
```
The DB physically rejects a label missing either key (`CHECK (x ? 'en' AND x ?
'ar')`). Applies to: service names, field labels, status labels, transition
labels, department names, level names, notification messages. Machine keys
(status keys, field ids, option values, capability keys) stay plain ASCII.

### I6. RTL from the first line. Never left/right.
Arabic is a requirement, not an afterthought.
```
BANNED                       CORRECT
margin-left: 8px             margin-inline-start: 8px
text-align: left             text-align: start
EdgeInsets.only(left: 8)     EdgeInsetsDirectional.only(start: 8)
Alignment.centerLeft         AlignmentDirectional.centerStart
```
Tailwind/CSS: `ms-*`/`me-*`/`ps-*`/`pe-*`/`text-start`/`text-end`, never the
`l`/`r` variants. **Test both directions on every screen** — English-only layout
is not finished.

### I7. The API contract is the source of truth.
`openapi.yaml` is **frozen**. Two developers build against it in parallel; a
unilateral change silently breaks the other's half. Do not invent an endpoint not
in the spec; do not change a response shape without changing the spec first;
changes require both developers to agree.

### I8. Validation is server-side. Client validation is UX only.
Forms are dynamic, so data off the wire is never trusted. Every payload is
validated on the server against the stored form definition. Client validation
mirrors the schema for kindness; the server's 422 (per-field, keyed by field
`id`) is authoritative.

### I9. The audit trail is immutable and transactional.
`request_status_history` and `audit_event` are **never updated, never deleted**.
A status change and its history row are written in the **same DB transaction** —
if they can diverge, the timeline can contradict the current status. One
`request_status_history` table powers the submitter's timeline, each employee's
activity history (filter by `changed_by`), and all outcome metrics.

### I10. Measure outcomes. Never behaviour.
This system does **not** track people.
```
YES   completed count, time-to-completion, reopen rate, open workload, SLA breaches
NO    live GPS, location history, idle time, "what are they doing right now"
```
An ethical, GDPR, and product position: a buyer wants an operations tool, not a
surveillance tool. Do not add behavioural tracking, even if asked casually.
**Two deliberate, scoped exceptions, both Time Clock:**
- `location_captured` (§6) — a mandatory one-shot device location fix at
  clock-in, checked then discarded if unused. A presence check at a single
  moment the employee themselves triggers, not tracking.
- **Re-scoped 2026-08-20 (deliberate):** clock-in and clock-out now also
  store the coordinate itself (`clock_in_lat/lng`, `clock_out_lat/lng` —
  `028_time_shift_clock_coordinates.sql`), visible to the shift's in-charge
  manager (web Time Clock page, both the Today tab and the Timesheets day
  dialog — `LocationPin`). Still a **single point per event, not a
  stream**: no location-history table, no polling, and critically **no
  geofencing/proximity check anywhere** — an employee is never blocked from
  clocking in/out based on *where* they are. Clock-in's fix stays
  **mandatory** (unchanged); clock-out's is **best-effort** — a field
  employee with no signal or who denies permission still clocks out, the
  coordinate is just `null`. No manager-approval/exemption workflow exists
  for this — that idea was explicitly considered and deferred.

Any *other* future feature that wants to *compare* a coordinate (e.g. "was
this shift on-site") is still a new decision, not a natural extension of
either exception above — flag it the same way before building it.

---

## 3. Hard constraints (in addition to the invariants)

- **Revised — there IS a visual Form Builder / Workflow Config UI.** Original
  MVP scope said definitions could only enter via the seed script; that's no
  longer true. `web/src/pages/AddServiceWizard.tsx` (admin-only, `POST
  /services`) lets an admin build a service's fields, statuses, and
  transitions through a wizard, validated server-side by the same
  `formSchema.js`/`workflowSchema.js` validators the seed script used to be
  the only caller of — nothing the UI submits can pass client-side and fail
  server-side for a different reason than "you left something blank." Seeding
  (`seed.js`) is still how the demo/dev data and the Owner's initial account
  get created, but it's no longer the only path to a new service. (The
  onboarding wizard is still separate — it configures the *company*, not
  forms/workflows.) The old JSON config API that onboarded whole sectors is
  still **removed** (§9, §13) — this is a from-scratch admin-authored service,
  not a return of sector-as-a-JSON-body onboarding.
- **Definitions are immutable once any request exists** for their service type.
  No versioning system; changing a live definition means adding a new service and
  disabling the old (documented MVP limitation).
- **No WebSockets, no push.** All "live" updates poll: notifications 30s,
  task/request lists 30s, detail pages on-focus refresh only.
- **No draft saving, no signature capture** — cut for MVP. If asked to build
  one, say so instead of proceeding.
- **Revised — self-service password reset now exists** (§13, supervisor-
  directed re-scope). `POST /auth/forgot-password` / `POST /auth/reset-password`
  (`routes/auth.js`) — this was on the "no self-service password reset" cut
  list; it no longer is. Still no forced-change flow for admin-issued temp
  passwords, and still no refresh tokens/server-side logout (both remain
  documented limitations, §15).
- **Every permission rule (§5) is enforced server-side**, never only hidden in
  the UI. Ownership checks are required *in addition to* capability checks.
- **No status keys hardcoded in application code** (§8). If a feature seems to
  need one, flag it.
- **Do not create abstractions, config layers, or helpers beyond what a task
  needs.** Match existing structure and patterns exactly.

---

## 4. Tech stack (decided — do not relitigate) & security baseline

- **Backend:** Node.js + **Express**, **JavaScript** (not TypeScript). REST under
  `/api/v1`. Data access is **node-postgres (`pg`) with raw SQL** — **no ORM,
  no Prisma**. Migrations are plain `.sql` files in `backend/migrations/`, run by
  `src/migrate.js`.
- **Database:** PostgreSQL + **PostGIS**. JSONB for form/workflow definitions and
  form responses; `GEOGRAPHY(Point,4326)` for request pins; row locking via
  `SELECT … FOR UPDATE`.
- **Web (Monitor dashboard):** React + **TypeScript** + Vite.
- **Mobile (User + Employee apps):** Flutter/Dart, single codebase with shared
  components (auth, dynamic form renderer, notifications, profile).
- **Auth:** JWT (jsonwebtoken); bcrypt (bcryptjs) password hashing.
- **File storage:** local disk under a non-web-root uploads dir, server-generated
  UUID filenames; DB stores metadata (§6).
- **Deployment:** one free-tier cloud host (Render/Railway) for backend + Postgres
  + web build; localhost demo is the always-available fallback.
- **Repo:** monorepo — `/mobile`, `/web`, `/backend`, `/docs`.

**Security baseline (backend):**
- JWT HS256, 24h expiry, secret from env var only (never committed). No refresh
  tokens (documented MVP limitation).
- Passwords: bcrypt, cost ≥ 10.
- Login rate limit: 5 attempts / 15 min per identifier+IP (in-memory is fine).
  `/auth/forgot-password` gets the identical shape on its own counter (§13).
- Never log request bodies on `/auth/*` or `/requests` (passwords / personal
  data). A new-hire's or a reset's password/token is emailed, never logged or
  written to `audit_event` (§13).
- Deactivated accounts (`is_active = false`) are rejected at JWT validation, not
  only at login.
- `login_identifier` is deliberately generic: an external `user` logs in with
  their email; an employee logs in with a **generated company email**
  (`lib/employeeEmail.js`: two letters of their first name + `.` + last name +
  `@` + the company's wizard-set `email_domain`, e.g. `ha.qanazi@company.org`;
  a colliding name gets a number inserted after the first-name part —
  `ha2.qanazi@...` — via an advisory-lock retry). One column, one lookup, one
  flow — do not split into two auth paths; this only changes what value
  populates that one column for a new employee, not the lookup itself.
  Server-generated always — a client never supplies one. **Superseded, then
  removed (2026-09-09, user-directed cleanup):** employees were previously
  allocated a 4-digit number instead (`1000 + department_id × 100` plus the
  lowest free offset per department, exhausted block → 409). That allocator
  (`lib/employeeNumber.js`) had been left in place but unused by `POST
  /employees` since the switch to generated emails; with no live caller left,
  it and its dedicated unit test (`test/employeeNumber.test.js`) were deleted.
  Existing employee rows hired before that switch keep whatever 4-digit
  `login_identifier` migration `011_employee_numbers.sql` already gave them —
  that stored data is untouched by removing the allocator code; only the
  ability to *generate new* ones this way is gone. Monitor/admin accounts are
  seed- or admin-created; `POST /auth/register` creates `user` role only.

---

## 5. Roles & the two-gate permission model (enforce every rule server-side)

Three account kinds (I2): `admin`, `employee`, `user`. Admins gate by **role**
(`requireRole('admin')`) and hold **no** capabilities — they configure, they do
not operate the queue. Every operational authority is an **employee** decision
resolved by the two gates (I3):

- **Gate 1 — capability.** The fixed catalogue (`lib/capabilities.js`):
  `view_all · assign · set_priority · override · manage_employees · export ·
  manage_events · manage_knowledge_base · view_all_company`. `manage_events`/
  `manage_knowledge_base` let a level author just one workforce feature
  module (§11) without also holding `view_all`'s general oversight. A
  `employee_level` grants a subset via `level_capability`. An "oversight"
  employee is one whose level grants `view_all`. `view_all_company` (added
  2026-09-04, user-directed) is a different kind of grant — it widens Gate 2
  itself rather than gating an action within it; see below.
- **Gate 2 — department scope.** Flat `department_id` match (`lib/scope.js`
  `subtreeIds` / `ownerInScope`) yields self + every co-member of the actor's
  own department (no manager tree — re-scoped, user-directed) — **or every
  user in the company, if the actor's level grants `view_all_company`**, the
  one operational (non-admin) path to company-wide reach. Request visibility
  for an employee = requests whose **service `owner_id` is in the actor's
  scope**. Assignment candidates = employees within that same scope.

**Ownership + 404-over-403:** "own only" resources (`request.user_id ==
me`, `task.employee_id == me`) require an ownership check on top of the gates. A
valid ID owned by someone else returns **404**, not 403, so IDs can't be probed.

**Employee limited task view:** `GET /tasks/{id}` embeds the requester's `name`
and `phone` but **not** `email`, and strips every `form_response` field whose
schema has `visible_to_employee: false`. That is the only field-filtering
mechanism.

**Deactivation rule:** deactivating an employee who still holds a task in a
non-terminal status returns **409** — reassign first, then deactivate.

**Locking rule:** every status-mutating operation locks the REQUEST row
(`SELECT … FOR UPDATE`) inside its transaction; all validation happens after the
lock. This closes check-then-act races (concurrent transitions, cancel-vs-assign).

**Testing rule:** the permission model is the test plan — every allowed/denied
combination gets at least one automated API test (§14).

**Feature gate (added 2026-08-04, orthogonal to Gates 1/2):** the five
workforce module route files (Time Clock, Schedule, Checklists, Knowledge
Base, Events) also require `requireFeature(key)`
(`middleware/auth.js`) — does the deployment's `company.features` (the
onboarding wizard's step-4 picks, §9) include this module at all. This isn't
about *who* may act (that's still Gate 1/2) — it's about whether the module
exists for this deployment, so there's no admin bypass: an unselected feature
is off for the Owner too. `companyFeatures` rides the same `/auth/me`/
`/auth/login` payload as `capabilities` so clients filter nav/routes the same
way (I4); the server is the actual enforcement.

**Auto-assign (added 2026-08-14, §13 re-scope — opt-in, not a third gate):**
`service_type.auto_assign` (default `false`). When on, `POST /requests`
ranks active employees in the service's own subtree
(`subtreeIds(service.owner_id)`, the same Gate-2 scope every other
assignment call uses) and fires the workflow's `required_capability: 'assign'`
transition automatically, in the same transaction as the request's creation
— via `lib/autoAssign.js`, reusing `workflowEngine.js`'s write path
(`applyTransition`) rather than a second hand-rolled one, so the status
write, task row, history row, audit row, and `assigned_to` notification are
byte-for-byte what a human `/assign` call produces. It is a no-op — the
request just stays unassigned, exactly like today — when the service hasn't
opted in, the workflow has no assign-capability transition from the initial
status (the existing gap: a service built without one is unassignable either
way, human or auto), or no eligible employee exists. There is no human actor
for a system pick, so Gate 1 doesn't apply here — authorization is the
service's own `auto_assign` flag, set only by an admin; Gate 2 is enforced by
construction, since the candidate pool can never be anything but the
service's own subtree. Always reversible: a human can reassign afterward
through the exact same UI as any manual reassignment.
**Re-scoped 2026-08-21 (deliberate — ranking, not just least-loaded):** the
candidate score is a weighted blend of three I10-safe outcome metrics, all
already tracked elsewhere in the app — reopen rate (weight 0.5, same
terminal→non-terminal history definition `dashboard.js`'s company-wide figure
uses, scoped per employee), avg resolution minutes (weight 0.3, same
request-creation-to-completion-transition definition `EmployeesPage`'s
per-employee column uses), and open task count (weight 0.2, the original
metric). Each metric is min-max normalized across the candidate pool before
weighting so the three different units are comparable; a candidate with no
completed-task history yet for a metric gets a neutral 0.5 rather than being
penalized or favored, so a brand-new hire is ranked on load alone until they
build a track record. Lowest score wins, ties broken by user id (this is what
gives the original load-only version its round-robin behaviour in practice,
preserved here for the all-neutral case). Local scoring over existing DB
data — no vendor call, no model — same I10-safe reasoning as the original
metric, just three of them instead of one.

---

## 6. Database schema (current — authoritative source is `backend/migrations/*.sql`)

Bilingual columns are JSONB `{en,ar}` with a DB `CHECK` on both keys (I5).

- **company** (v7) — id, name, address (JSONB `{en,ar}`, **both required** —
  the Owner types both halves in the wizard; `name` is shown to every
  console/mobile user via the wordmark regardless of *their* language, so I5's
  rule applies the same as a system label — `address` isn't rendered anywhere
  yet but gets the same treatment since it's owner-entered tenant data of the
  same shape), employee_range, industry
  (sub_industry dropped `033_drop_sub_industry.sql`, user-directed,
  2026-09-03 — pure classification data collected alongside industry that
  nothing ever read; see §9), plan, email_domain (plain TEXT — genuinely Owner-only tenant
  data nobody else's UI renders; plan is step 7, its `employeeCap`
  server-enforced on hire — see §9; email_domain is step 5, the domain suffix
  generated employee login emails use — see §4), features
  (`TEXT[]` of selected feature keys), logo_file_id (FK → file_attachment, nullable),
  phone, **onboarding_completed**
  (bool, default false — the first-login gate), created_at. name/address
  stay nullable (the row exists pre-onboarding with no values
  yet); the bilingual CHECK passes NULL through unchanged. (owner_job_title —
  same shape, same nullable-pre-onboarding treatment — dropped
  `034_drop_owner_job_title.sql`, user-directed, 2026-09-03: required
  bilingual data with no display use anywhere in the app; see §13.) At most
  one row per
  deployment (single-org, §13); a table not a singleton so branches/features get
  clean FKs and can grow to multi-tenant later.
- **branch** (v7) — id, company_id (FK, cascade), name (JSONB `{en,ar}`, same
  rationale as company's), created_at. One row per branch the Owner names in
  the wizard.
- **department** — id, name `{en,ar}`, head_user_id (FK → users, nullable —
  Owner-only CRUD via `/departments`, §12; **display metadata only, not a
  scope mechanism** — Gate 2 is flat department membership, so every
  `view_all` holder in a department has equal reach over it, head or not).
  **Re-scoped, user-directed: creating a department needs only a name +
  branch** — headEmployeeId and memberEmployeeIds are both optional; an
  empty department can be staffed later via `PATCH /employees/{id}`, the CSV
  import's department column, or `PATCH /departments/{id}/head`. Deactivating
  a head is refused (409) until the Owner reassigns the department's head
  first (`PATCH /departments/{id}/head`) — no automatic fallback (there is no
  more manager to promote). The Add Department web dialog
  (`DepartmentsPage.tsx`) offers one unified employee checklist with a "Head"
  radio (only one at a time, only among checked rows) — `headEmployeeId` +
  `memberEmployeeIds` in the POST body either way. Checking someone already
  in a different department shows a confirmation step listing exactly who
  gets moved before the write fires. `PATCH /departments/{id}/head` (the
  separate reassign-head flow, an existing department's head only) is its own
  dropdown, unaffected by the create dialog.
- **users** — id, name (computed `${firstName} ${lastName}` for employees created
  through the extended Add Employee form — see §5's login_identifier note), email
  (nullable, unique), password_hash, role
  (`admin`/`employee`/`user`), phone (nullable — required at creation/edit for a
  new employee since 2026-08-21, §13; column stays nullable so pre-existing rows
  aren't broken), department_id (FK, nullable),
  **login_identifier** (unique — an email, a generated employee login email, or a
  legacy 4-digit employee number — see §4), first_name, last_name, birthdate (date,
  nullable — same required-for-new-hires/nullable-column split as phone), gender,
  worker_type (both plain TEXT machine keys, i18n-translated client-side like
  `priority` — not a bilingual JSONB catalogue, since I5 doesn't require one for
  small fixed system enums; also required-for-new-hires/nullable-column), weekly_rest_day (nullable smallint
  0–6, JS weekday convention — one fixed day off/week, `/schedule/suggest`'s
  input, §13), **level_id** (FK → employee_level, nullable),
  **company_id** (FK → company, nullable — the account's company; nullable so the
  Owner, created before the company row, and self-registered users stay valid),
  is_active (default true), created_at.
- **capability** — key (PK; the fixed catalogue).
- **employee_level** — id, name `{en,ar}`.
- **level_capability** — (level_id, capability_key). Gate 1 grants.
- **service_type** — id, **key** (unique string handle), name `{en,ar}`,
  department_id (FK), default_priority, enabled, **owner_id** (FK → users; the
  visibility anchor, Gate 2), **accepts_external_users** (bool),
  **auto_assign** (bool, default false — §5's re-scope; opt-in, toggleable
  post-creation unlike the form/workflow definition itself).
- **form_definition** — id, service_type_id (FK), form_type
  (`request`/`completion`), field_schema (JSONB, §7). Unique (service_type_id,
  form_type) — exactly two rows per service.
- **workflow_definition** — id, service_type_id (FK, unique 1:1), statuses
  (JSONB), transitions (JSONB). Semantics in §8.
- **request** — id, user_id (FK), service_type_id (FK), form_response (JSONB),
  status (a status key), priority (`low`/`medium`/`high`), created_at, updated_at,
  **location** (`GEOGRAPHY(Point,4326)`, nullable — denormalized from the form's
  `location` field).
- **request_status_history** — id, request_id (FK), status, changed_by (FK),
  changed_at, note (nullable; required when the transition sets `requires_note`
  and for oversight overrides). Reassignments/priority changes also write a row.
- **task** — id, request_id (FK, **unique** — one task per request, updated in
  place on reassignment), employee_id (FK), status, completion_form_response
  (JSONB, nullable), assigned_at. `TASK.status` is intentional denormalization
  kept in sync with `REQUEST.status` in the same transaction.
- **request_comment** — id, request_id (FK), user_id (FK), body, created_at.
- **notification** — id, user_id (FK), request_id (FK, nullable), type, message
  `{en,ar}`, is_read, created_at.
- **file_attachment** — id (UUID), request_id XOR task_id XOR time_entry_id
  (CHECK: exactly one non-null), original_filename, mime_type, size_bytes,
  storage_path (never exposed), uploaded_by (FK), uploaded_at.
- **time_shift** — id, employee_id (FK), company_id (FK), clock_in_at,
  clock_out_at (nullable), source (`clock`/`manual`), status
  (`active`/`completed`), approval_status (`pending`/`approved`/`edited`),
  note, approved_by/approved_at, **location_captured** (bool, default false —
  a `clock` source shift requires the mobile app to obtain a one-shot device
  location fix before `POST /timeclock/clock-in` will accept it,
  `lib/timeClock.js` `validateClockInLocation`. A `manual`/edited entry has
  no live clock-in moment, so it's always false), **clock_in_lat/lng,
  clock_out_lat/lng** (nullable double precision,
  `028_time_shift_clock_coordinates.sql` — the manager-visible coordinate
  for each event, §2 I10's second exception. clock-in's pair is always set
  when `location_captured` is true; clock-out's is best-effort and often
  null). Each pair is one point fixed at the moment the employee acts, never
  a stream, never a history table, never compared to anything — I10 stays
  intact. At most one `active` shift per employee (DB-enforced unique
  index, not app locking).
  **time_break** — shift_id (FK),
  break_start_at, break_end_at (nullable, at most one active per shift).
  **time_entry** — shift_id (FK), type (`note`/`photo`/`tip`), body, amount,
  created_by — in-shift extras; a `photo` entry is the parent for a
  `file_attachment`.
- **shift_template** — id, company_id (FK), name `{en,ar}`, start_time,
  end_time. Manager-defined named shifts (e.g. "Morning 9–5"), Schedule
  feature. **schedule_entry** — id, employee_id (FK), company_id (FK), date,
  shift_template_id (FK), created_by. Unique (employee_id, date) — one shift
  per employee per day, a flat date-by-date roster with no recurrence engine.
  This is Time Clock's late/absent/overtime baseline: `lib/timeClock.js`
  reads the day's `schedule_entry` (if any) instead of a fixed weekly
  pattern; no entry for a date means late/absent/overtime never fire for
  that employee on that date.
- **audit_event** — actor_id, action, entity_type, entity_id, detail (JSONB),
  created_at. Two families, both written via `logAudit` in the same transaction
  as the change (I9): config/admin actions (service.created, employee.created, …)
  and operational actions (request.status_changed, request.assigned,
  request.priority_changed) written by the workflow engine and the
  assign/priority handlers. The operational family deliberately duplicates the
  `request_status_history` timeline so the admin audit page is one feed.
- **password_reset_token** (`031_password_reset.sql`, §13) — id, user_id (FK,
  cascade), token_hash (sha256 of the raw token; the raw value is never
  stored, only emailed), expires_at, used_at (nullable — single-use),
  created_at. A fresh `/auth/forgot-password` call deletes any prior row for
  that user before inserting, so there's at most one live token per user.

Location is a real geography column, not a string in JSONB — spatial analysis
later needs new *queries*, not a migration.

---

## 7. Dynamic form engine

Field schema (`FORM_DEFINITION.field_schema` — JSONB array; array order = display
order):
```jsonc
{
  "id": "stable key used in form_response",
  "label": {"en":"…","ar":"…"},
  "type": "text | multiline | number | date | dropdown | radio | checkbox | photo | location",
  "required": true,
  "options": [{"value":"k","label":{"en":"…","ar":"…"}}],  // dropdown/radio only
  "min": 0, "max": 100,
  "visible_to_employee": true
}
```
- `options`: required for `dropdown`/`radio`, forbidden otherwise.
- `min`/`max`: numeric bounds for `number`; length bounds for `text`/`multiline`.
- `checkbox` = single boolean. `photo` = a FILE_ATTACHMENT id (two-step upload:
  `POST /files` first, then put the returned id into `form_response` under the
  field's `id`; backend verifies the attachment exists and belongs to the caller).
- `location` = `{lat,lng}` (lat ∈ [-90,90], lng ∈ [-180,180], exactly two keys);
  max one location field per form (seed-time check); no options/min/max.
- **Deliberately excluded** (not a form-builder platform): default values,
  conditional/branching fields, regex, custom messages, multi-file, sections,
  computed fields.

**Backend validation** (`validateFormResponse.js`, one generic function): validate
against the stored schema; reject unknown keys → 422; enforce
required/type/min-max/option-membership → 422 per-field keyed by `id`; for
`photo`, the attachment must exist and belong to the caller.

**Seed-time validation** (`formSchema.js` / `workflowSchema.js`, enforced before
insert; the API then trusts stored schemas): unique field ids · valid types ·
options present exactly when required · min ≤ max · bilingual labels · exactly one
`is_initial`, ≥1 `is_terminal` · all transition `from`/`to` exist · exactly one of
`required_capability`/`actor` per transition · valid `notify` targets.

---

## 8. Dynamic workflow engine (Phase 4 model)

```
statuses:    { key, label:{en,ar}, is_initial, is_terminal, sla_minutes }
transitions: { key, from, to, label:{en,ar}, required_capability, actor,
               required_form_key, requires_note, notify:[…] }
```
- **`is_terminal`** replaced the old category enum. All cross-service logic —
  dashboard "open vs closed" grouping, filters, the task lock, cancel gating —
  operates on `is_terminal`, never on status keys.
- A transition is gated by **exactly one** of `required_capability` (Gate-1
  oversight, `actor:null`) or **`actor`** (`requester` | `assignee`, whose turn it
  is; `capability:null`).
- `required_form_key` names a FORM_DEFINITION the transition requires (e.g.
  `completion`) — the transition only executes with a valid form for it.
- `requires_note` → history row must include a note (422 without).
- `notify` = relationships resolved at fire time: `created_by`, `assigned_to`,
  `assignee_manager` (never user ids / roles). This keeps notifications generic.
- `sla_minutes` = minutes a request may sit in this status before the escalation
  sweep fires (§10).

**Transitions are ONE-WAY.** A backward edge (reassign) and a reopen are just
extra transition rows. The engine has **no concept of a loop** — do not add one.

**Engine rules** (`workflowEngine.js`, the ONE module that writes
`REQUEST.status`/`TASK.status`): lock REQUEST row → check the transition exists
from current status → check Gate 1 (capability) and/or Gate 2 + ownership (actor)
→ check note/form requirements → write both statuses + a history row → commit →
fire notifications (§10). Nothing else may write status. While the
current status is `is_terminal`, the task is locked (409 on further task calls);
a reopen transition unlocks it automatically.

**Endpoints** (see `openapi.yaml`): the generic
`GET`/`POST /requests/{id}/transitions` serves all **actor**-gated transitions,
with `expected_status` for optimistic concurrency (**409** on stale — exactly one
concurrent fire wins). Oversight (capability-gated) transitions fire via the
dedicated `PATCH /requests/{id}/assign` · `/priority` · `/status`. Employee task
actions go through `/tasks/{id}` + `/tasks/{id}/transitions`.

The engine still proves the config-driven thesis: three structurally different
workflow shapes — **dispatch + hold loop**, **lean scheduled pickup**, **approval
gate + reject terminal** — run on one unchanged engine, same code, different JSON.
(The v7 seed no longer ships these municipal workflows; they live in the git
history and the demo fixtures under `docs/demo/`.)

---

## 9. Onboarding wizard & Owner provisioning (v7)

The old JSON config API (`POST /config/services`) and outbound webhooks are
**removed** (§13). Sector onboarding-as-a-JSON-body is gone; a deployment is one
company, brought online by provisioning + a wizard.

**Owner provisioning** (`seed.js`, run once per sale): TRUNCATEs, inserts the fixed
capability catalogue, one **empty `company`** (`onboarding_completed = false`), and
one **Owner** (`role 'admin'`, `login_identifier` = their email, `company_id` set).
Credentials come from `SEED_OWNER_*` env vars; it refuses to run against a database
that already has users unless `SEED_FORCE=true`. The Owner is `admin` (I2):
configures, has no department, holds no capabilities.

**Onboarding endpoints** (`routes/onboarding.js`, both `requireAuth`; the save is
`requireRole('admin')`):
- **`GET /onboarding/options`** — the static wizard catalogue from
  `lib/onboardingOptions.js`: employee ranges, industries + their sub-industries,
  feature groups, and plan tiers (all `{en,ar}` labels). Thin client renders it (I4).
- **`GET /onboarding/geocode?q=…`** — step-1 address helper. Server-side proxy to
  OpenStreetMap Nominatim (its usage policy forbids calling it from a browser and
  requires a descriptive User-Agent + ~1 req/sec throttling, both enforced here);
  returns only `{ match: { city, country } | null }`, never the raw upstream
  response. The wizard debounces on the address field and auto-appends the
  country on an exact city match. **This is the one deliberate exception to "no
  named vendor integrations" (§13)** — flagged and agreed as a one-off, not a
  precedent for adding others without the same conversation.
- **`PATCH /company/onboarding`** — the wizard's one save. Validates every pick
  **server-side against the catalogue** (I8), writes the `company` row + its
  `branch` rows in **one transaction**, then flips `onboarding_completed` (one-shot:
  a second call after completion is **409**). Optional logo is a parentless
  `file_attachment` the Owner POSTed to `/files` first (admins may create the
  parentless company-logo upload). Step 5's `emailDomain` is validated as a bare
  domain (no scheme/path) and is what `lib/employeeEmail.js` appends to every
  generated employee login. Step 7's `plan` pick sets a real limit: `POST
  /employees` (`routes/employees.js`) looks up the company's plan and, if its
  `employeeCap` isn't null (Enterprise = unlimited), counts active employees and
  refuses the hire with **409** once at cap — message names the plan and cap and
  says to contact support to upgrade (no working upgrade/billing flow exists;
  see below). Step 2's employee-range answer is only a size hint here — step 7
  shows a non-blocking warning if a plan's cap looks too small for it, but
  doesn't stop the Owner picking it anyway; the plan's own cap is the one real
  gate. **Plans differ ONLY by employeeCap** (re-scoped 2026-09-03, user-
  directed — a plan used to also show a per-plan "includes: Operations,
  Communication" feature-group list, record-only and never server-enforced,
  which implied a restriction that didn't exist; see §13). Step-4 feature
  selection is separate and unrestricted by plan — every plan can pick every
  module. No pricing, checkout, or billing of any kind — that stays on the "deliberately
  NOT built" list (§13), which is why hitting the cap points the Owner to
  support rather than an in-app upgrade action.

**The first-login gate:** `onboardingCompleted` rides on the `/auth/login` and
`/auth/me` user payloads (joined from the Owner's company). The React app routes an
`admin` whose company is not yet onboarded to the wizard instead of the console;
`markOnboarded()` drops the gate on save. Other account kinds never see it.

*(Ponytail ceiling: single-org, and onboarding itself is still one-shot — a
second `PATCH /company/onboarding` is 409. Changing company details later is
no longer a direct row update: `GET`/`PATCH /company` + the console's Settings
page edit the same row after the fact, §15's 2026-08-22 re-scope.)*

---

## 10. Notifications & SLA / escalation

**Notification triggers (complete list — do not invent others):** task
assigned/reassigned → assignee; any status change → request owner; task completed
→ owner; employee rejected task → assignee's department head; comment added →
the other party. Targets are the relationships in §8, resolved at fire time.

**SLA / escalation** (`lib/escalation.js`, a periodic sweep, `ESCALATION_SWEEP_MS`,
default 5 min): a request sitting in a status past its `sla_minutes` escalates
**to the assignee's department head** (re-scoped, user-directed — the manager
tree is gone, §2 I3/§6), falling back to the service owner when the request is
unassigned, the assignee has no department, their department has no head, or
they themselves are the head. Reuses the existing sweep worker. (The
`sla_breached` webhook it once fired is removed — §9.)

---

## 11. The apps (frozen scope)

**User mobile:** Login/Registration · Home · Service Catalogue · Create Request
(dynamic form) · My Requests + Details/Timeline (list, detail, timeline, comments,
cancel, confirm/dispute resolution, attachments, map pin).

**Employee mobile:** Home + My Tasks · Task Details · workflow transitions ·
Complete Task (dynamic completion form) · **Workforce feature modules** (shipped
post-pivot, not yet gated by the company's onboarding feature selection — §15):
Time Clock (clock in/out — clock-in requires a one-shot device location fix,
§2 I10 exception, §6 — breaks, manual hours, in-shift notes/photos/tips) ·
Schedule (my roster) · Checklists · Knowledge Base · Events (RSVP). Time Off is **not** a separate module — it's a normal
service type through the dynamic form/workflow engine (I1), themed as its own
screen over `/requests` + `/services`.

**Monitor web:** Login · **First-login onboarding wizard** (v7 — the seven-step
"Customize your app in 1 minute", gated on an un-onboarded Owner) · Dashboard
Overview (stats grouped **open vs closed**, per-service + per-priority totals,
30-day chart) · Requests Management + Assignment (list/filters + detail pane,
timeline, comments, assign/reassign, priority, status override, map view) ·
Employees Management · Departments Management · Employee Levels · Reports + CSV
export · Audit · **Workforce feature modules** (shipped post-pivot): Time Clock
(shift/timesheet oversight + CSV export) · Schedule (shift templates + roster) ·
Checklists (forms-and-checklists submission stats, aggregated from existing
request/workflow data, not a new engine surface) · Knowledge Base ·
Events. Each module route is capability-gated (§5) — `view_all` for
the oversight views, plus `manage_events`/`manage_knowledge_base` for
authoring that module without granting general oversight.

**Shared component:** Notifications + Profile, reused by both mobile apps.

**Branding has a build-time default and one runtime override, post-onboarding**
(`web/src/brand.ts`, `web/.env.example`, `web/src/components/Wordmark.tsx`): the
generic "MonitorFlow" name/pip come from `VITE_BRAND_*` at build time, used on
the login page (rendered pre-auth, so it can never know a company) and the tab
title. Once an Owner completes onboarding, `<Wordmark>` in the **console shell
only** prefers their company's own name and uploaded logo instead — both ride
the authenticated `/auth/login`/`/auth/me` payload (`companyName`/`companyLogo`,
the logo inlined as a data URI by `routes/auth.js` so the `<img>` never needs
its own authenticated fetch against the per-file-gated `GET /files/{id}`). This
is a deliberate, scoped exception to "no branding API, no runtime lookup" for
the shell only — the login page still never does a runtime lookup, and there is
still no public/unauthenticated branding endpoint. Mobile app name and icon stay
build-time only, in `pubspec.yaml` / `AndroidManifest.xml` / `Info.plist` — this
override doesn't extend there. **Never rebrand `X-MonitorFlow-Signature`** —
that is a wire protocol subscribers verify, not a company name.

**UI-state rule (every page):** loading + empty states on every list; a
confirmation dialog on every destructive/terminal action, with a note field where
the workflow requires one; 401 → login; 403/404 → inline error. No page is "done"
without these.

**Work division:** *Student 1* — Flutter User + Employee apps, shared mobile
components, the seed/demo-data script, the Employees + Reports web pages, mobile
testing. *Student 2* — schema + migrations, API, auth + permission middleware,
form/workflow engines, file + notification services, the onboarding wizard
(backend + React), the React scaffold + Login + Dashboard + Requests Management,
deployment.

---

## 12. API contract

`openapi.yaml` (repo root) is the contract (I7) — the authoritative list of every
endpoint, request/response shape, and status code. Do not duplicate it here and do
not let this file contradict it. **v7 reconciliation:** the pivot removed the
`/config/*` surface and added `/onboarding/options` + `/company/onboarding`.
Employee management is fully reconciled to the live routes — all under
`/employees` (people tag, `manage_employees` capability); the old `/config/{org,
levels,capabilities,employees}` paths are gone. **Correction (2026-08-04, found
live during the web E2E checklist pass — this file previously said the
opposite):** Gate-1 level *authoring* is not seed-time only — `/employee-levels`
has full CRUD (admin-only `POST`/`PATCH`/`DELETE`; `PATCH` accepts a
`capabilities` array that fully replaces a level's `level_capability` grants in
one call), and it backs a live, working editor on the web console's Levels &
Capabilities page — every checkbox there toggles a real grant immediately, no
re-authoring step needed. `GET /employee-levels` reads the catalogue for both
that page and the Add Employee "role" picker. `/departments` now has full CRUD
(Owner-only create/rename/delete/reassign-head, §6), documented in the
contract. Still undocumented in `openapi.yaml`: `/employee-levels`'s write
endpoints and `/users/me*`. When in doubt,
the mounted routes in `backend/src/index.js` are ground truth. Key conventions it
encodes: base
path `/api/v1`; Bearer JWT on every route except register/login; standard list
params `?page&pageSize(≤100)&status&state&serviceTypeId&priority&dateFrom&dateTo&q`;
status codes 200/201/204/400/401/403/404/409/422/429/500 used exactly; dynamic-form
errors are 422 keyed by field `id`; CSV export prefixes any cell starting with
`= + - @` with `'` (injection guard). Files: allowlist `jpg/jpeg/png/pdf`, ≤5 MB,
MIME validated by magic bytes, UUID name outside web root, served
`Content-Disposition: attachment`.

---

## 13. Deliberately NOT built (do not add without a deliberate re-scoping decision)

standalone Operations Monitor page ·
WebSocket live refresh ·
**live/continuous GPS tracking, location history,
behavioural monitoring** (I10) · signature capture · draft saving · satisfaction
ratings · multi-organization / true multi-tenancy (single-org per deployment;
"many companies" = one deployment each) · payments · advanced BI · **named vendor
integrations** (except the three explicitly re-scoped exceptions below) ·
request deadlines · form/workflow versioning · refresh tokens / server-side
logout.

**Re-scoped 2026-07-31 (deliberate, was on this list): the visual Form
Builder / Workflow Config UI.** `AddServiceWizard.tsx` + `POST /services`
(§3) now let an admin author a service's fields/statuses/transitions
through the console instead of only via the seed script. Still gated
admin-only, still validated server-side by the original seed-time
validators, still subject to the immutability rule (§3) — this widens *who*
can author a definition, not what a definition is allowed to contain.

**Re-scoped 2026-08-14 (deliberate, was on this list): automatic assignment.**
Manual assignment (the server returns a subtree-scoped candidate list, a
human chooses) is still the default and stays fully available on every
service. Auto-assign is opt-in **per service** (`service_type.auto_assign`,
set by an admin building the service through Add Service, or toggled later
via `PATCH /services/{id}/auto-assign`) — see §5 and §8 for the design.

**Removed in v7 (do not re-add without a deliberate decision):** the JSON **config
API** (`POST /config/services` — sector-as-data onboarding) and **outbound signed
webhooks** (`/config/webhooks`, `lib/webhooks.js`, the `X-MonitorFlow-Signature`
delivery). The municipality seed (`company-config.js`) went with them.

**Removed 2026-08-21 (deliberate, supervisor decision — do not re-add without
the same conversation): the Directory and Training & Onboarding feature
modules.** Low product/thesis value relative to their effort: neither
exercised the dynamic form/workflow engine or the two-gate permission model
beyond a basic company-wide read, unlike Time Clock (I10's location-capture
exception), Schedule (Time Clock's late/absent baseline), or Checklists
(reuses the request/workflow engine, no new surface). Backend routes,
migrations (`024_training.sql`, `025_module_capabilities.sql`'s
`manage_training` grant, `027_training_attachment.sql`, dropped by
`029_remove_training_directory.sql`), the `manage_training` capability, web
pages, and mobile screens are gone; the onboarding wizard's feature catalogue
(`lib/onboardingOptions.js`) no longer offers either. A company already
carrying one of these keys in its `features` array keeps it stored — nothing
retroactively strips it — but the module it once unlocked no longer exists.

**Re-scoped 2026-08-21 (deliberate, second exception to the named-vendor
ban — supervisor decision): bilingual auto-fill via the Gemini API.**
`POST /translate` (`lib/translate.js`, `routes/translate.js`) is a server-side
proxy to Google's Gemini API, same shape as the Nominatim geocode proxy (§9):
the vendor key (`GEMINI_API_KEY`) never reaches the client, and the caller
gets back only the translated string, never the raw upstream response. Given
one side of a bilingual `{en,ar}` field pair (I5) the admin/employee already
typed, it suggests the other — an explicit "Translate" button, never
autofire-while-typing, so it can't clobber something the caller was about to
type themselves. Purely a UX shortcut: the caller can still edit or reject
the suggestion, and every save endpoint (services.js, knowledgeBase.js,
events.js, `PATCH /company/onboarding`, …) still validates both languages
are present itself (I5, I8) exactly as before — this route has no write path
of its own and isn't in the trust chain for anything it doesn't type.
Frontend: `components/TranslateButton.tsx`, one shared component wired into
every bilingual field pair across the console (Add Service, the onboarding
wizard, Knowledge Base, Events, Levels, Departments). Add Service's field and
status editors — the two places a form can have many bilingual rows at once —
also get `components/TranslateAllButton.tsx`: a sequential loop over the same
per-row call (`lib/translate.ts`'s `translatePair`), not a combined multi-row
API call, so a bad response only ever affects the one row currently being
translated and it stays naturally rate-limit-friendly. Not added to the
two-field forms (Knowledge Base, Events, Levels, Departments, Onboarding) —
one click is already trivial there.

**Added 2026-08-21 (deliberate, same AI feature track as auto-assign ranking):
AI-suggested scheduling.** `POST /schedule/suggest` (`routes/schedule.js`,
`manage_employees`) proposes `schedule_entry` rows for a manager to review —
a chosen shift template across chosen weekdays in a date range, for the
caller's subtree (or an explicit subset), rotated fairly when `perDay` caps
who's picked each day by who has worked the fewest shifts in a trailing
30-day lookback (a local heuristic over existing data, same reasoning as
auto-assign's ranking — no vendor call). Deliberately **preview-only**: it
has no write path of its own and never overwrites an existing entry — the
manager applies the result through the unchanged `PUT /schedule/roster`, so
a human stays in the loop on every write, unlike auto-assign's
opt-in-and-fire pattern. Web: `SuggestDialog` on the Roster tab
(`SchedulePage.tsx`), generate → review a count/list preview → apply.

**Added 2026-08-21, same session: `users.weekly_rest_day`** (nullable
smallint 0–6, `030_employee_weekly_rest_day.sql`) — one fixed day off per
week per employee, set on hire or edit (Add/Edit Employee web form,
`PATCH /employees/{id}` now accepts it alongside name/phone/department/
level). Answers a real gap the AI-suggested scheduling design surfaced: the
weekday checkboxes on `/schedule/suggest` are a **company**-level working
pattern (5-day, 6-day, any subset), but nothing previously captured an
**employee** working fewer days than that — e.g. a 6-day company week where
staff are individually contracted for 5 and rotate which day they're off.
`/schedule/suggest` now skips a candidate on their `weekly_rest_day` before
ranking (`restDaySkipped` in the response, surfaced in the web preview).
Deliberately scoped small, not the general availability/preference table
this AI feature track originally flagged as a blocker — a single static
day, not rotating rest days, not multiple days off, not per-week variation.
Extend to a real availability table only if one of those turns out to
matter in practice.

**Re-scoped 2026-08-21 (deliberate, third exception to the named-vendor ban
— supervisor-directed, was previously on the "deliberately NOT built" list):
self-service password reset + credentials-by-email.** `lib/mailer.js` is a
thin SMTP wrapper (env-configured — `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`,
`.env.example`), same "vendor key never reaches the client" shape as the
Nominatim/Gemini proxies; unlike those two it isn't a fixed named service —
it's whatever SMTP account a deployment points it at (a free Gmail app
password works for dev/small-scale). If `SMTP_HOST` is unset, it logs the
message instead of sending — never a hard dependency, and every caller
treats it as best-effort (a hire or a reset request still succeeds even if
mail delivery fails).
- **Credentials by email:** `POST /employees` and `PATCH /employees/{id}/reset-password`
  (`routes/employees.js`) now email the login + password to the employee's
  real `email` column — distinct from `login_identifier` (§4), which is a
  synthetic handle built from name + the company's onboarding-set
  `email_domain` and not necessarily a deliverable mailbox on its own. The
  admin still also sees the credential once in the UI (existing reveal-once
  behavior, unchanged) — email is an added delivery channel, not a
  replacement for it.
- **Forgot password:** `POST /auth/forgot-password` / `POST /auth/reset-password`
  (`routes/auth.js`, `031_password_reset.sql`'s `password_reset_token`
  table). Single-use, 1-hour-expiry token; only its sha256 hash is ever
  stored, so a leaked DB row can't be replayed as a working link. Forgot-
  password always returns the same response whether or not the identifier
  matched an account — no enumeration, rate-limited the same 5-per-15-min
  shape as login (§4), separate counter so the two can't lock each other
  out. Web: a "Forgot password?" link on `LoginPage.tsx` →
  `ForgotPasswordPage.tsx` (request) → `ResetPasswordPage.tsx` (the emailed
  link lands here, reads `?token=`). Applies to all three account kinds
  (I2) — `user` accounts reset against the real email they registered with;
  admin/employee reset against `email`, same as the credentials-by-email
  path above. Mobile (student 1's surface, §11): `LoginScreen`'s
  "Forgot password?" link opens `ForgotPasswordScreen` (the same
  `POST /auth/forgot-password`, same enumeration-safe confirmation either
  way) — shared by both the User and Employee apps, same as the login
  screen itself. Deliberately **no native "set new password" screen**: the
  emailed link opens `ResetPasswordPage.tsx` (above) in the device's
  browser — a public page with no console/role gate, so it completes the
  reset for a mobile-only account exactly as well as a console one — rather
  than building app deep-linking (custom URL scheme or platform App/
  Universal Links) that doesn't exist anywhere in this app yet. Revisit only
  if the browser hand-off turns out to be an actual usability complaint.

**Added 2026-08-21, same session: bulk employee import from CSV.** User-
requested — hiring one at a time doesn't scale for a company onboarding a
large existing team. `POST /employees/import` (`routes/employees.js`,
multipart, field `file`, ≤500 rows/2 MB) and `GET /employees/import/template`
(a starter CSV). Deliberately **CSV, not real `.xlsx`**: parsing Excel's
binary format needs a new dependency, CSV needs none, and Excel opens/saves
CSV natively — `lib/csv.js` is a small hand-rolled RFC4180-ish parser (no
library), unit-tested directly (no DB/server). No password column — each
row gets a random temp password (same shape as `PATCH
/employees/{id}/reset-password`) delivered only through the credentials
email above, never echoed back in the response or written to disk. Every
row is validated and inserted independently through `createEmployeeRow` —
the exact same function `POST /employees` itself now calls, refactored out
so bulk isn't a second, hand-rolled create path — so a bad row's 422-style
errors are reported per-row without touching the good ones.
**User-confirmed: partial success, not all-or-nothing** — the response
always lists both `created` and `failed` (each keyed by CSV row number,
header = row 1), and the plan's seat cap is enforced as a running counter
across the file, not just once up front, so a batch that would cross the
cap partway through fails only the rows that would exceed it. Only an admin
caller gets `department`/`level` CSV columns resolved (matched by name,
case-insensitive, against the company's own catalogue) — a non-admin
importer's hires all land in their own department, same restriction
`POST /employees` already applies. Web: `emp_import` button on
`EmployeesPage.tsx` opens a dialog (download template → pick file → submit
→ a results table of failed rows only, since the good ones are already
visible in the list once it reloads).

**Re-scoped 2026-08-21, same session: Add Employee's required fields.**
User-directed — now that credentials are always emailed (above), an
admin-typed initial password is redundant; phone/birthdate/gender/
worker-type were optional and, before this, effectively write-only (captured
at hire, never shown or editable again). `createEmployeeRow` (shared by
`POST /employees` and the CSV import path, above) now requires
firstName/lastName/email/**phone/birthdate/gender/workerType**, and never
accepts a client-supplied password — one is always generated and delivered
only by the credentials email, returned once more as `tempPassword` in the
201 response (same reveal-once shape as `loginIdentifier`) as a fallback if
mail is slow or down. `PATCH /employees/{id}` gained phone/birthdate/gender/
workerType as editable — they may change to another valid value but not
clear to null (422), unlike `weeklyRestDay`, which stays the one genuinely
optional field here. DB columns stay nullable (`users.phone/birthdate/
gender/worker_type` — I8, app-level enforcement, not a `NOT NULL`
constraint) so pre-existing rows hired before this change aren't broken by
a migration; only new creates/edits are held to it. **Worker type now has a
real use** (user-asked "how can we use it"): `GET /employees?workerType=`
filters the list (same shape as `departmentId`), and the Employees table
shows it as a column. Birthdate and gender still have **no** display/report
surface yet (deliberately not built this session — age display, birthday
reminders, and demographic reporting were discussed as options but nothing
was requested beyond making the field required); `weeklyRestDay` stays
optional on purpose — CLAUDE.md's own reasoning above still holds: it's an
*exception* field for staff working fewer days than the company's week, not
something every hire needs, so requiring it would misfit a simple
single-schedule company.

**Added 2026-08-22 (same session as the Add Service review): the onboarding
wizard's feature step now requires at least one module**, on the client and in
`PATCH /company/onboarding`. An empty `features` array left the deployment with
no Time Clock, Schedule, Checklists, Knowledge Base or Events at all
(`requireFeature` blocks every module route), and clicking straight past step 4
was enough to ship that. The same save now also parks any department with no
`branch_id` in the first branch the Owner names (`seed.js`'s starter department
had none and nothing else connected it, so the branches were captured and then
appeared in no UI), requires the logo to be an **image** (the wordmark renders
it in an `<img>`, so the general `/files` allowlist's PDFs became a permanent
broken image), and writes a `company.onboarded` audit row like every other
config action (§6). The wizard gained a final **review step** before the
one-shot save, and maps the server's 422 field keys back to the step they came
from instead of stranding the Owner on the last step under a generic error.

**Re-scoped 2026-09-01 (deliberate, user-directed): department creation no
longer requires a head or members.** `POST /departments` used to require a
head + ≥1 other employee up front; name + branch are now the only
requirements. An Owner can create an empty department and staff it later,
either manually (Edit Employee's department picker, `PATCH
/departments/{id}/head`) or via the CSV import's department column. Web: the
Add Department dialog's Submit button no longer requires a head or checked
employees — the employee checklist stays available for staffing it
immediately, now labeled optional.

**Re-scoped 2026-09-01, same session (deliberate, user-directed, bigger:
dropped the manager-tree architecture in favor of a flat department-head
model).** `users.manager_id` (self-FK, arbitrary-depth reporting tree) is
**removed** (`032_drop_manager_id.sql`), along with `lib/scope.js`'s
recursive-CTE `subtreeIds`/`ownerInScope`/`ancestorIds` and the cycle-guard
they existed to protect (the 2026-08-21 incident's fix — moot once there's no
tree left to cycle). **Gate 2 (I3, §5) is now flat department membership**:
an employee's scope is exactly their own department's co-members, self
included — no multi-level hierarchy, no "root employee reaches the whole
org" case for anyone but the admin (who has no department and sees
everything by construction, unchanged). `department.head_user_id` (020) is
now **purely display metadata** — every `view_all` holder in a department has
equal Gate-2 reach over it, head or not; it no longer re-points any other
member's row on reassignment (`lib/departmentHead.js` simplified
accordingly). Ripple effects, all re-scoped the same session:
- **Assignment/visibility** narrows from "subtree" to "own department" —
  `lib/autoAssign.js`'s candidate pool, `POST/PATCH /employees`'s Gate-2
  checks, and every route that called `subtreeIds`/`ownerInScope` are
  unchanged in *shape* (same function signatures), just department-scoped
  now instead of tree-scoped.
- **`assignee_manager` notifications (§10) and SLA escalation** now resolve
  to the assignee's **department head** (falling back to the service owner
  when the assignee has no department, their department has no head, or
  they themselves are the head — never escalate to yourself). The
  `assignee_manager` relationship *key* is unchanged (§8's notify enum) —
  only what it resolves to changed.
- **Employee create/edit lost `managerId`** entirely — `POST /employees`,
  `PATCH /employees/{id}`, and the CSV import's `manager` column are gone (a
  new hire just inherits the caller's department, or an admin-supplied
  `departmentId`). Web: `EmployeesPage.tsx`'s Manager picker and its
  "defaults to the department's head" convenience are both gone.
- **Deactivating a department head** no longer auto-promotes anyone — there
  is no more manager to fall back to. It's a flat refusal (409) until the
  Owner reassigns the head first (`PATCH /departments/{id}/head`); the old
  "falls back to the outgoing head's own manager, or refuses if none" logic
  in `routes/employees.js` is gone.
No named-sector/industry branch was ever involved here (I1 untouched) — this
is purely Gate 2's shape. `openapi.yaml` and this file are reconciled; the
2026-08-21 `departments.api.test.js` cycle-guard regression suite is deleted
(its entire premise no longer exists) and `employees.api.test.js`/
`employeesImport.api.test.js`'s manager-specific tests are removed with it.
The shared test fixture (`testlib/harness.js`) now builds **two** departments
so cross-department-refusal tests still have an actor genuinely outside the
main fixture's scope (previously two "subtrees" via `manager_id`, now two
departments).

**Re-scoped 2026-09-03 (deliberate, user-directed): dropped `sub_industry`
from onboarding.** Step 2 collected an industry + a sub-industry, both pure
classification data (I1 — neither ever branches behaviour, same as a country
dropdown); the sub-industry half had a UX gap the industry field doesn't
(no bilingual auto-fill helper works on a fixed picklist the way the address
field's geocode/TranslateButton helpers do) and, once checked, nothing in
the codebase ever *read* it beyond storing and displaying it back in
Settings — pure collection with no payoff. Dropped: the `sub_industry`
column (`033_drop_sub_industry.sql`), `INDUSTRIES[].subs` and
`SUBS_BY_INDUSTRY` from `lib/onboardingOptions.js`, the field + its
validation from both `PATCH /company/onboarding` and `PATCH /company`, the
wizard's step-2 field and review-step row, Settings' matching field, and the
`ob_sub_industry` i18n key. `industry` itself is untouched — still a flat,
un-cut picklist (I1 means every industry gets the identical engine, so
there's no such thing as an "unsupported" industry to cut). `openapi.yaml`
and this file are reconciled.

**Re-scoped 2026-09-03, same session (deliberate, user-directed): dropped the
`hr_skills` feature group and its sole feature, `time_off`, from the
onboarding/Settings feature catalogue.** Not a scope trim like the ones
above — a real bug find: `time_off` was never actually gated by anything.
Time Off has always been "a normal service type through the request engine
(I1), not one of the [gated] modules — always offered" (§11, and verbatim
in `mobile/lib/employee/employee_home.dart`'s drawer-item comment) — no
backend route, web page, or mobile screen ever checked
`company.features.includes('time_off')`. So the step-4 checkbox controlled
nothing; checking or unchecking it had zero effect on what staff saw. Since
`time_off` was the only feature in `hr_skills`, the group is dropped
entirely rather than left empty, along with `hr_skills` from the Enterprise
plan's descriptive `featureGroups` card and its mirror on the public
`/welcome` landing page (`LandingPage.tsx`, which hand-copies
`onboardingOptions.js`'s PLANS/FEATURE_GROUPS since that page is pre-auth
and can't fetch `/onboarding/options`). The mobile Time Off screen itself
(`time_off_screen.dart`) and the `service_type.feature_key` tagging
mechanism it filters on (`020_service_feature_key.sql`) are untouched —
those are a different, unrelated concept from the onboarding wizard's
`company.features` array, and Time Off staying always-offered regardless of
selection is unchanged, deliberate product behavior, not something this
re-scope touches.

**Re-scoped 2026-09-03, same session (deliberate, user-directed): plans no
longer show a per-plan feature-group list.** `PLANS[].featureGroups` — a
record-only, never-server-enforced "includes: Operations, Communication"
line on each plan card — implied plans gated which feature modules a
company could pick; they never actually did (§9's own text already said
so, the UI just didn't match it). Dropped `featureGroups` from
`lib/onboardingOptions.js`'s `PLANS` entries, the wizard's plan-card
"Includes: …" line and its now-unused `.ob-plan-includes` CSS, the public
`/welcome` landing page's mirrored plan cards and `.landing-plan-includes`
CSS, the `ob_plan_includes` i18n key, and the `featureGroups` property from
`openapi.yaml`'s plan schema (its description corrected at the same time:
`employeeCap` **is** server-enforced, unlike the removed field). Plans now
differ by `employeeCap` only; step-4 feature selection is unaffected by
which plan is picked.

**Re-scoped 2026-09-03, same session (deliberate, user-directed): dropped
`owner_job_title` from onboarding/Settings.** A fourth required bilingual
field pair on step 1, alongside name/address/phone. Same shape as the
`sub_industry` and Time Off cuts above: required, round-tripped into
Settings' edit form, and never actually displayed anywhere else in the
app — not the wordmark (only `name`/the logo ride the `/auth/me` payload),
not mobile, no directory-style screen. Its own stated rationale ("shown via
the wordmark or future pickers") no longer holds: the most likely "future
picker" was the Directory module, itself removed 2026-08-21 (§13). Dropped:
the `owner_job_title` column (`034_drop_owner_job_title.sql`), the field +
its `TranslateButton` from step 1 of the wizard and from Settings, its
review-step row, and — since step 1 is now down to two bilingual pairs
(name, address) — the step's `TranslateAllButton` too, matching the
existing "two-field forms don't need it" rule this file already states for
Knowledge Base/Events/Levels/Departments. `openapi.yaml` and this file are
reconciled.

**Added 2026-09-04 (deliberate, user-directed): `view_all_company`, an
operational path to company-wide Gate-2 scope.** Prompted by a direct
question about whether a "root employee who sees everything" could be
added back — flagged first, since that's exactly what the manager-tree
removal above deliberately eliminated ("no root employee... except the
admin"). The actual need turned out to be narrower and legitimate: an
operational account (a General Manager who still works requests/tasks,
unlike the Owner, who holds no capabilities and doesn't operate the queue,
I2) that needs company-wide reach rather than just its own department's.
Built as a capability, not a role or a resurrected tree — `view_all_company`
joins the fixed catalogue (`lib/capabilities.js`, `035_view_all_company_
capability.sql` for already-provisioned databases) and is checked directly
inside `scope.js`'s `subtreeIds`/`ownerInScope`: a level holding it makes
its employees' scope the whole company, computed the same way admin's
whole-company scope already was (both collapse to "no department filter"),
just triggered by a capability grant instead of account role. Orthogonal to
every other capability (§2 I3, §5) — it widens **where** authority reaches,
not **what** an employee can do once there. Surfaced in the Levels &
Capabilities live editor (`LevelsPage.tsx`) like any other capability
checkbox, including the "select all" toggle added the same session.
**Near-miss caught before shipping:** the test fixture's shared "Manager"
level blanket-granted every row in the `capability` table, so adding this
key would have silently given the fixture's two separate-department test
actors (`root`, `head2`) company-wide scope each, collapsing the
cross-department-refusal tests the flat-scope re-scope above depends on.
Fixed by excluding `view_all_company` from that blanket grant
(`testlib/harness.js`) and adding a dedicated positive test
(`employees.api.test.js`) that builds an isolated level holding it and
proves the cross-department reach directly, rather than trusting the SQL
by inspection alone.

**Re-scoped 2026-09-07 (supervisor-mandated, was on this list): push
notifications.** Supervisors require the mobile apps to deliver a
notification even while backgrounded/closed, not just the existing 30-second
in-app poll (§3, §11). Requirement recorded here; **not implemented yet, and
not to be built as a quiet default** — it needs a push vendor (FCM is the
practical default for one Flutter codebase covering Android/iOS), which is a
**4th named-vendor exception** alongside Nominatim/Gemini/SMTP (§9/§13),
each of which got its own explicit two-student conversation before landing.
Same bar applies here: agree the vendor and the delivery-token/registration
design (device token storage, a new `device_token` table or column,
platform-specific credentials) before writing code, not after.

**Added 2026-09-07 (supervisor-mandated): full employee evaluation system.**
New requirement, not yet designed — scope, metrics, and schema are still to
be decided. Whatever it
measures must stay outcome-based per **I10** (§2): completion count,
time-to-completion, reopen rate, SLA adherence, and similar — never a
behavioural/surveillance metric. I10 applies to every feature in this
project equally; a new system doesn't get a pass on it.

**Added 2026-09-07 (supervisor-mandated): CSP backtracking for scheduling.**
`POST /schedule/suggest`'s greedy fairness-ranking heuristic (§13's
2026-08-21 AI-suggested-scheduling entry) is being replaced with a proper
constraint-satisfaction backtracking solver over the same inputs (shift
templates, chosen weekdays/date range, `weekly_rest_day` skips, no
double-booking) and the same **preview-only** contract into
`PUT /schedule/roster` — a human still applies the result, nothing here
starts auto-writing the roster. Local computation over existing DB data
either way, no vendor call, so this doesn't touch the named-vendor list.

**Flagged 2026-09-07, NOT approved — recorded, do not build:** the same
supervisor meeting also asked for (a) a company-wide group chat and (b)
periodic employee location tracking (5–15 min intervals), both owned by a
different student (Abdallah), not in this file's current task order.
Group chat is new, uncontroversial scope. **Periodic location tracking
directly contradicts I10** (§2 — "no live GPS, location history... An
ethical, GDPR, and product position", explicitly not a preference) and the
project's own prior, deliberate call on this exact question: the Time Clock
location feature (§2, §6) was scoped down on purpose to a single point
captured at clock-in/out, with an explicit note that "no geofencing/
proximity check anywhere" and that comparing a coordinate to anything is
"still a new decision, not a natural extension" of that exception. A polling
interval is exactly the live-tracking shape I10 was written to rule out.
Per this file's own top-of-document rule ("flag the contradiction instead
of silently resolving it either way"), this entry only records that the
requirement was raised — it is **not** a re-scope. Reversing I10 for this
needs the same kind of explicit, both-students-plus-supervisor decision
`view_all_company` got above, made deliberately, not inherited by default
because a meeting mentioned it.

**IN:** the **first-login onboarding wizard** (v7, §9) · the interactive **map pin
picker** (v5) · **operational audit rows** (status/assign/priority write
`audit_event`) · **bilingual auto-fill** (Gemini, above) · **AI auto-assign
ranking** (§5) · **AI-suggested scheduling** (above) · **self-service
password reset + credentials-by-email** (above) · **bulk employee import
from CSV** (above). GPS tracking stays
out (I10).

---

## 14. Testing (release gate)

- **Unit (backend):** form-validation (each type × required/bounds/options/unknown
  key) · workflow transition validator (valid/invalid/wrong-capability/wrong-actor/
  terminal-locked/stale) · onboarding-save validation (each pick against the
  catalogue; one-shot 409).
- **API integration (most of the budget):** happy path + negatives per endpoint
  against a test DB.
- **Permission suite:** one test per allowed/denied combination — a capable actor
  outside their subtree is refused; a subtree member without the capability is
  refused.
- **Flutter:** widget tests for the dynamic renderer only (schema → widgets;
  required blocking).
- **React:** manual E2E checklist per page.
- **Manual acceptance:** the core flows (register→login, submit, review+assign,
  accept/reject, status updates, complete, confirm, dispute, cancel/reopen,
  reports+CSV) on **all** seeded services, on the deployed build, run by the
  student who didn't write that layer.

**Must-pass negatives:** own-resource of another user → 404 · transition not in
valid set → 409 · wrong-capability transition → 403 · duplicate assign → 409 ·
task action under a terminal request → 409 · unknown field id → 422 · missing/bad/
out-of-range/invalid-option → 422 field-keyed · `.exe` renamed `.jpg` → rejected
(magic bytes) · upload >5 MB → 422 · non-admin config/CSV → 403 · concurrent
transitions → exactly one wins · cancel-vs-assign race → one wins other 409 ·
deactivated JWT → 401 · deactivate employee holding an open task → 409 · confirm
before done → 409 · cross-subtree assign → refused · override to nonexistent
status → 422 · download another user's file → 404 · user submit to internal-only
service → 403 · hire past the plan's employee cap → 409 · clock-in with
missing/out-of-range location → 422 · forgot-password on a real vs. fake
identifier → identical response · expired/reused/unknown reset token → 422 ·
CSV import: a bad row alongside good ones → good ones created, bad one
reported, neither blocks the other · unknown department/level name
in a row → that row only fails · import row count over the limit → 422 ·
hire missing phone/birthdate/gender/workerType → 422 field-keyed, no
password error · edit clearing a required field (e.g. `gender: null`) → 422 ·
cross-department reach without `view_all_company` → 404, the same level
holding it → 200.

---

## 15. Documented MVP limitations (state these in the report; do not "fix" them)

Redundant `TASK.status` (intentional denormalization) · immutable definitions, no
versioning · reassignment overwrites `employee_id` (history note is the audit) ·
polling latency · 24h JWT, no refresh/revocation · email enumeration on register ·
single organization per deployment · temporary passwords not force-changed · no
automated frontend E2E.

**Re-scoped 2026-08-22 (deliberate, user-directed — this was listed here as a
limitation to state, not fix): company settings are editable after
onboarding.** The old wording was "onboarding is one-shot with no in-app edit
(change company details by direct row update, including turning a feature on
after the fact)". Hand-editing a live database is not something a buyer can
do, and three of the wizard's answers — the step-4 feature picks, the logo,
and the branches — were otherwise permanent. `GET /company` + `PATCH /company`
(`routes/company.js`, admin-only) now edit the same row the wizard writes,
validated against the same `lib/onboardingOptions.js` catalogue the onboarding
save uses (I8). Web: `SettingsPage.tsx`, one flat form under a new admin-only
**Settings** nav item. **Onboarding itself stays one-shot** — `PATCH
/company/onboarding` still 409s after completion and `onboarding_completed` is
never touched by the settings path; this edits the row afterwards, it does not
re-run the wizard. Branches are a full replace (an id renames, no id inserts,
an omitted id deletes — 409 while a department still points at it), and a plan
downgrade below the current active headcount is refused with the same limit
`POST /employees` enforces on hire.

**Corrected 2026-08-04** (this used to be listed here as a limitation — it
isn't anymore): the onboarding wizard's feature-module selection now *does*
gate module routes/pages. `requireFeature()` (`middleware/auth.js`) checks
`company.features` independently of Gate 1/2, applied to all five module
route files (Time Clock, Schedule, Checklists, Knowledge Base, Events) —
no admin bypass, since an unselected feature doesn't
exist for the deployment at all, Owner included. The client
(`companyFeatures` on the `/auth/me`/`/auth/login` payload) filters the nav
and routes the same way, purely for UX — the server is what actually
enforces it.

---

## 16. How to work on this project

- Scope every task to one feature or one page — never "build the app" as one task.
- For anything touching the **form engine, workflow engine, permission
  middleware, or config API**: outline your approach and the files you'll touch
  first, wait for confirmation, then implement. These are the highest-risk
  modules.
- For straightforward CRUD/UI following an established pattern: implement directly.
- Every feature is **run and manually verified against seeded data** before it is
  "done" — not just read.
- Commit after each verified feature, naming the page or endpoint it implements —
  never batch features into one commit.
- Never create test data by hand or via ad-hoc SQL — extend the seed script
  (`seed.js`) so every developer and demo starts identical. (Exception:
  temporarily flipping a flag for a negative test, then flipping back.)
- No status keys in application code — `is_terminal`, capabilities, and actors
  only. If a task seems to need one, **flag it**.
- If a request conflicts with the invariants (§2) or any constraint here, **say so
  explicitly** instead of quietly complying or refusing.

**Before you commit — stop if any is true:**
- [ ] A file names a specific sector.
- [ ] A check reads `role === '…'` (other than `requireRole('admin')`).
- [ ] A permission is enforced only on the client.
- [ ] A `margin-left` / `text-align:left` / `EdgeInsets.only(left:)`.
- [ ] A user-facing string that isn't `{en,ar}`.
- [ ] A status change without its history row in the same transaction.
- [ ] An endpoint not in `openapi.yaml`.

**The one-sentence test:** *If onboarding a new sector would require changing
code, the project is broken.*

import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { I18nProvider } from './i18n'
import RequireAuth from './components/RequireAuth'
import LoginPage from './pages/LoginPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import LandingPage from './pages/LandingPage'
import OnboardingWizard from './pages/OnboardingWizard'
import DashboardShell from './pages/DashboardShell'
import DashboardPage from './pages/DashboardPage'
import RequestsPage from './pages/RequestsPage'
import EmployeesPage from './pages/EmployeesPage'
import DepartmentsPage from './pages/DepartmentsPage'
import ReportsPage from './pages/ReportsPage'
import EvaluationsPage from './pages/EvaluationsPage'
import TimeClockPage from './pages/TimeClockPage'
import SchedulePage from './pages/SchedulePage'
import ChecklistsPage from './pages/ChecklistsPage'
import KnowledgeBasePage from './pages/KnowledgeBasePage'
import EventsPage from './pages/EventsPage'
import LevelsPage from './pages/LevelsPage'
import AuditPage from './pages/AuditPage'
import AddServiceWizard from './pages/AddServiceWizard'
import ServicesPage from './pages/ServicesPage'
import SettingsPage from './pages/SettingsPage'
import ProfilePage from './pages/ProfilePage'

// Two-gate routing: oversight employees and the admin share the shell but not
// the pages. Each page needs a capability (Gate 1) — or the admin kind for the
// account/config surfaces. The server enforces the same with 403s; this just
// keeps the UI from rendering pages that would only show errors.
// `orAdmin` admits the admin (Owner) into a capability-gated page too — used
// only where the backend was updated to match (requireCapabilityOrAdmin):
// Dashboard, Employees, and Reports (ReportsPage disables export itself,
// matching the server, which kept requireCapability('export') strict — no
// admin bypass). Requests stays capability-only on purpose: requests.js
// excludes admin at the router level (`requireRole('user', 'employee')`),
// deliberately, so the per-route "field-employee → 403, user → own" checks
// can't let admin fall through to unrestricted oversight visibility — not
// just a missing capability flag, don't add orAdmin here without revisiting
// that exclusion first. Everywhere else stays capability-only.
// `need` takes an array where the backend also accepts more than one
// capability (requireCapabilityOrAdmin('view_all', 'manage_X')) — the module
// pages (knowledge base, events) so a level holding only that module's
// capability, not view_all, can still reach its own page.
type Capability =
  | 'view_all' | 'manage_employees' | 'manage_knowledge_base' | 'manage_events'

// The first console route each capability grants, most-general first, paired
// with the feature key that route also needs (null = not feature-gated) —
// used to send a denied user somewhere they CAN reach instead of bouncing
// them back to a page they just failed (which would loop for anyone without
// view_all, e.g. a level holding only manage_knowledge_base). A candidate
// whose feature isn't enabled for this company is skipped too, or the loop
// would just move from "denied by capability" to "denied by feature" instead.
const HOME_BY_CAPABILITY: [Capability, string, string | null][] = [
  ['view_all', '/', null],
  ['manage_employees', '/employees', null],
  ['manage_knowledge_base', '/knowledge-base', 'knowledge_base'],
  ['manage_events', '/events', 'events'],
]

function homeFor(user: { role: string; capabilities: string[]; companyFeatures: string[] }): string {
  if (user.role === 'admin') return '/audit'
  const hit = HOME_BY_CAPABILITY.find(
    ([cap, , feature]) => user.capabilities.includes(cap) && (feature === null || user.companyFeatures.includes(feature))
  )
  return hit ? hit[1] : '/'
}

// Module routes (knowledge base, events, time clock, schedule, checklists)
// also need the onboarding wizard's step-4 feature pick — independent of
// Gate 1 (need). The server enforces this too (requireFeature,
// middleware/auth.js); this only keeps the UI from rendering pages that
// would only show a 403.
type Feature = 'time_clock' | 'schedule' | 'forms_checklists' | 'knowledge_base' | 'events'

// eslint-disable-next-line react-refresh/only-export-components -- entrypoint file, fast refresh doesn't apply
function Guard({
  need,
  orAdmin,
  feature,
  children,
}: {
  need: Capability | 'admin' | Capability[]
  orAdmin?: boolean
  feature?: Feature
  children: ReactNode
}) {
  const { user } = useAuth()
  if (!user) return null
  const needed = Array.isArray(need) ? need : [need]
  const capabilityOk =
    needed[0] === 'admin'
      ? user.role === 'admin'
      : needed.some((n) => user.capabilities.includes(n)) || (orAdmin === true && user.role === 'admin')
  const featureOk = !feature || user.companyFeatures.includes(feature)
  if (!capabilityOk || !featureOk) {
    // Send each kind to a page it can actually reach, not a hardcoded one —
    // otherwise a non-view_all capability holder denied at '/' would loop.
    return <Navigate to={homeFor(user)} replace />
  }
  return children
}

// First-login gate: an Owner (admin) whose company hasn't run the wizard yet
// sees it instead of the console. markOnboarded() (called on save) flips the
// flag and this stops intercepting. Only the admin kind is gated — oversight
// employees and the seeded flow never hit onboardingCompleted === false.
// eslint-disable-next-line react-refresh/only-export-components -- entrypoint file, fast refresh doesn't apply
function OnboardingGate({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (user?.role === 'admin' && user.onboardingCompleted === false) return <OnboardingWizard />
  return children
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
      <AuthProvider>
        <Routes>
          <Route path="/welcome" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <OnboardingGate>
                  <DashboardShell />
                </OnboardingGate>
              </RequireAuth>
            }
          >
            <Route index element={<Guard need="view_all" orAdmin><DashboardPage /></Guard>} />
            <Route path="requests" element={<Guard need="view_all"><RequestsPage /></Guard>} />
            <Route path="requests/:id" element={<Guard need="view_all"><RequestsPage /></Guard>} />
            <Route path="employees" element={<Guard need="manage_employees" orAdmin><EmployeesPage /></Guard>} />
            <Route path="evaluations" element={<Guard need="view_all" orAdmin><EvaluationsPage /></Guard>} />
            <Route path="departments" element={<Guard need="admin"><DepartmentsPage /></Guard>} />
            <Route path="reports" element={<Guard need="view_all" orAdmin><ReportsPage /></Guard>} />
            <Route path="timeclock" element={<Guard need="view_all" orAdmin feature="time_clock"><TimeClockPage /></Guard>} />
            <Route path="schedule" element={<Guard need="view_all" orAdmin feature="schedule"><SchedulePage /></Guard>} />
            <Route path="checklists" element={<Guard need="view_all" orAdmin feature="forms_checklists"><ChecklistsPage /></Guard>} />
            <Route path="knowledge-base" element={<Guard need={['view_all', 'manage_knowledge_base']} orAdmin feature="knowledge_base"><KnowledgeBasePage /></Guard>} />
            <Route path="events" element={<Guard need={['view_all', 'manage_events']} orAdmin feature="events"><EventsPage /></Guard>} />
            <Route path="levels" element={<Guard need="admin"><LevelsPage /></Guard>} />
            <Route path="audit" element={<Guard need="admin"><AuditPage /></Guard>} />
            <Route path="services" element={<Guard need="admin"><ServicesPage /></Guard>} />
            <Route path="settings" element={<Guard need="admin"><SettingsPage /></Guard>} />
            {/* No Guard: self-service account edit, open to any signed-in console account. */}
            <Route path="profile" element={<ProfilePage />} />
            <Route path="services/new" element={<Guard need="admin"><AddServiceWizard /></Guard>} />
            <Route path="services/:id/edit" element={<Guard need="admin"><AddServiceWizard /></Guard>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
)

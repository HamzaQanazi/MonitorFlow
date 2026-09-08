// Sidebar nav icons — simple stroke line icons matching NotificationBell's
// SVG convention (24x24 viewBox, stroke=currentColor so they inherit the
// link's muted/active/hover color, no separate icon library — a dozen-odd
// hand-drawn shapes don't earn a new dependency).
const common = {
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const PATHS: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.3" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.3" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.3" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.3" />
    </>
  ),
  requests: (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </>
  ),
  reports: (
    <>
      <line x1="6" y1="19" x2="6" y2="10" />
      <line x1="12" y1="19" x2="12" y2="5" />
      <line x1="18" y1="19" x2="18" y2="13" />
    </>
  ),
  employees: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </>
  ),
  evaluations: (
    <>
      <polygon points="12,3.5 14.6,9 20.5,9.8 16.2,13.8 17.3,19.7 12,16.8 6.7,19.7 7.8,13.8 3.5,9.8 9.4,9" />
    </>
  ),
  departments: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="1" />
      <line x1="9" y1="9" x2="9" y2="9.01" />
      <line x1="15" y1="9" x2="15" y2="9.01" />
      <line x1="9" y1="13" x2="9" y2="13.01" />
      <line x1="15" y1="13" x2="15" y2="13.01" />
      <line x1="12" y1="20" x2="12" y2="16.5" />
    </>
  ),
  levels: (
    <>
      <circle cx="7.5" cy="14.5" r="3.3" />
      <line x1="9.8" y1="12.2" x2="19" y2="3" />
      <line x1="14.5" y1="7.5" x2="17" y2="5" />
    </>
  ),
  timeclock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="12" x2="12" y2="7" />
      <line x1="12" y1="12" x2="15.5" y2="14" />
    </>
  ),
  schedule: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <line x1="4" y1="9.5" x2="20" y2="9.5" />
      <line x1="8" y1="3" x2="8" y2="6.5" />
      <line x1="16" y1="3" x2="16" y2="6.5" />
    </>
  ),
  checklists: (
    <>
      <rect x="5.5" y="4" width="13" height="17" rx="1.5" />
      <rect x="9" y="2.5" width="6" height="3" rx="1" />
      <polyline points="8.5,13 11,15.5 15.5,10" />
    </>
  ),
  knowledge_base: (
    <>
      <path d="M12 6.5c-1.8-1.3-4.2-1.8-6.5-1.3v12.5c2.3-.5 4.7 0 6.5 1.3 1.8-1.3 4.2-1.8 6.5-1.3V5.2c-2.3-.5-4.7 0-6.5 1.3Z" />
      <line x1="12" y1="6.5" x2="12" y2="18.9" />
    </>
  ),
  events: (
    <>
      <line x1="6" y1="3" x2="6" y2="21" />
      <path d="M6 4.5c3-1.3 5 1.3 8 0v9c-3 1.3-5-1.3-8 0Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1" />
    </>
  ),
  services: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  add_service: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3.5 5 6v6c0 4.5 3 7.5 7 8.5 4-1 7-4 7-8.5V6Z" />
      <polyline points="8.5,12 11,14.5 15.5,9.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
      <path d="M12 3.5c2.3 2.3 3.5 5.3 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.3-3.5-8.5S9.7 5.8 12 3.5Z" />
    </>
  ),
  signout: (
    <>
      <path d="M14.5 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2v-2" />
      <line x1="9" y1="12" x2="21" y2="12" />
      <polyline points="17.5,8.5 21,12 17.5,15.5" />
    </>
  ),
}

// Unrecognized keys render nothing rather than throw — defensive, same
// posture as the dynamic form renderer's "unknown type" rule (I4).
export function NavIcon({ name }: { name: string }) {
  const path = PATHS[name]
  if (!path) return null
  return (
    <svg className="nav-icon" width="17" height="17" aria-hidden="true" {...common}>
      {path}
    </svg>
  )
}

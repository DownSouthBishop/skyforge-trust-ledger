import { Link, useLocation } from "react-router-dom";
import { Users, Inbox, BarChart3, Target, Megaphone, Building2, type LucideIcon } from "lucide-react";

interface NavItem {
  label: string;
  url: string;
  Icon: LucideIcon;
}

const LINDA_NAV: NavItem[] = [
  { label: "Leads", url: "/linda/leads", Icon: Users },
  { label: "Inbox", url: "/linda/inbox", Icon: Inbox },
  { label: "Dashboard", url: "/linda/dashboard", Icon: BarChart3 },
  { label: "ICP", url: "/linda/icp", Icon: Target },
  { label: "Campaigns", url: "/linda/campaigns", Icon: Megaphone },
  { label: "Clients", url: "/linda/clients", Icon: Building2 },
];

// Shared pipeline sub-nav — present on every Linda page (including chat) so the operator
// can move between lead generation, outreach review, tracking, and reporting without
// backtracking through /linda first. Same tab-pill pattern already used across the app
// (not a sidebar) to stay visually consistent with the rest of Linda's pages.
export default function LindaNav() {
  const location = useLocation();

  return (
    <nav aria-label="Linda pipeline" className="flex gap-1 p-1 rounded-xl w-fit flex-wrap"
         style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
      {LINDA_NAV.map(({ label, url, Icon }) => {
        const active = location.pathname === url;
        return (
          <Link key={url} to={url}
            aria-current={active ? "page" : undefined}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50"
            style={active ? { background: "rgba(168,85,247,0.2)", color: "#a855f7" } : { color: "#71717a" }}>
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

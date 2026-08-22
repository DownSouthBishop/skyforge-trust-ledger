import { NavLink } from "react-router-dom";
import {
  Globe, TrendingUp, User, BarChart3, Target, Flame, LineChart, Brain, BookOpen,
  Building2, Home, Bot, MessageSquare, Eye, Network, GraduationCap, Briefcase,
  Wallet, Receipt, Lock, Activity, Layers, NotebookText, Sparkles, Table2, LucideIcon
} from "lucide-react";

const items: { title: string; url: string; icon: LucideIcon }[] = [
  { title: "HQ", url: "/", icon: Globe },
  { title: "Atlas", url: "/atlas", icon: Flame },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Chat", url: "/agent-chat", icon: MessageSquare },
  { title: "Veil", url: "/veil", icon: Layers },
  { title: "Command", url: "/command", icon: BarChart3 },
  { title: "Positions", url: "/positions", icon: TrendingUp },
  { title: "Markets", url: "/markets", icon: LineChart },
  { title: "Strategies", url: "/arsenal", icon: Target },
  { title: "Dossier", url: "/dossier", icon: Brain },
  { title: "Vault", url: "/vault", icon: BookOpen },
  { title: "Business", url: "/business", icon: Building2 },
  { title: "Real Estate", url: "/realestate", icon: Home },
  { title: "Financial", url: "/financial-hq", icon: Wallet },
  { title: "Spend", url: "/spend-tracker", icon: Receipt },
  { title: "Chamber", url: "/closed-chamber", icon: Lock },
  { title: "Metrics", url: "/metrics", icon: Activity },
  { title: "Linda", url: "/linda", icon: Eye },
  { title: "WIG", url: "/wig", icon: Network },
  { title: "Projects", url: "/projects", icon: Briefcase },
  { title: "Forge", url: "/mental-forge", icon: GraduationCap },
  { title: "Notebook", url: "/notebook", icon: NotebookText },
  { title: "Skills", url: "/skills", icon: Sparkles },
  { title: "Airtable", url: "/airtable", icon: Table2 },
  { title: "Profile", url: "/profile", icon: User },
];

const MobileNav = () => (
  <nav
    className="fixed bottom-0 left-0 right-0 z-50 md:hidden glass-card-strong border-t border-border/30"
    style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
  >
    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar px-2 py-1.5 [-webkit-overflow-scrolling:touch]">
      {items.map((item) => (
        <NavLink
          key={item.url}
          to={item.url}
          end={item.url === "/"}
          className={({ isActive }) =>
            `flex shrink-0 flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg transition-all min-w-[56px] ${
              isActive ? "text-accent bg-accent/10" : "text-primary/60"
            }`
          }
        >
          <item.icon className="h-4 w-4" />
          <span className="text-[9px] font-medium leading-none whitespace-nowrap">{item.title}</span>
        </NavLink>
      ))}
    </div>
  </nav>
);

export default MobileNav;

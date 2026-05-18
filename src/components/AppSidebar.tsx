import { NavLink as RouterNavLink } from "react-router-dom";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Globe, TrendingUp, User, BarChart3, Target, Flame, LineChart, Brain, BookOpen, Building2, Home, MessagesSquare, LucideIcon
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

const navItems: { title: string; url: string; icon: LucideIcon }[] = [
  { title: "HQ", url: "/", icon: Globe },
  { title: "Atlas", url: "/atlas", icon: Flame },
  { title: "Discourse", url: "/discourse", icon: MessagesSquare },
  { title: "Command", url: "/command", icon: BarChart3 },
  { title: "Positions", url: "/positions", icon: TrendingUp },
  { title: "Markets", url: "/markets", icon: LineChart },
  { title: "Strategies", url: "/arsenal", icon: Target },
  { title: "Dossier", url: "/dossier", icon: Brain },
  { title: "Vault", url: "/vault", icon: BookOpen },
  { title: "Business", url: "/business", icon: Building2 },
  { title: "Real Estate", url: "/realestate", icon: Home },
  { title: "Profile", url: "/profile", icon: User },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon" className="border-r border-border/50">
      <SidebarContent className="bg-sidebar">
        {/* Brand */}
        <div className={`p-4 flex items-center gap-3 border-b border-border/30 ${collapsed ? "justify-center" : ""}`}>
          <img
            src={skyforgeEagle}
            alt="Skyforge"
            className="w-8 h-8 rounded-lg object-cover"
          />
          {!collapsed && (
            <span className="font-display text-sm tracking-widest text-primary text-glow-blue">
              SKYFORGE
            </span>
          )}
        </div>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <RouterNavLink
                      to={item.url}
                      end={item.url === "/"}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                          isActive
                            ? "bg-accent/10 text-accent glow-orange"
                            : "text-primary hover:bg-primary/5 hover:text-primary"
                        }`
                      }
                    >
                      <item.icon className="h-5 w-5 shrink-0" />
                      {!collapsed && <span className="text-sm font-medium">{item.title}</span>}
                    </RouterNavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

import { NavLink as RouterNavLink } from "react-router-dom";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Globe, LayoutDashboard, User, BarChart3, Shield, Flame, Users, Brain, LucideIcon
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
  { title: "Command", url: "/", icon: Globe },
  { title: "Atlas", url: "/forge", icon: Flame },
  { title: "Income", url: "/dashboard", icon: LayoutDashboard },
  { title: "Clients", url: "/clients", icon: Users },
  { title: "Arsenal", url: "/arsenal", icon: Shield },
  { title: "Intel", url: "/intel", icon: BarChart3 },
  { title: "Dossier", url: "/dossier", icon: Brain },
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

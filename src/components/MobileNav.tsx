import { NavLink } from "react-router-dom";
import { Globe, TrendingUp, BarChart3, LineChart, User } from "lucide-react";

const items = [
  { title: "Command", url: "/", icon: Globe },
  { title: "Positions", url: "/positions", icon: TrendingUp },
  { title: "Markets", url: "/markets", icon: LineChart },
  { title: "Intel", url: "/intel", icon: BarChart3 },
  { title: "Profile", url: "/profile", icon: User },
];

const MobileNav = () => (
  <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden glass-card-strong border-t border-border/30">
    <div className="flex items-center justify-around py-2">
      {items.map((item) => (
        <NavLink
          key={item.title}
          to={item.url}
          end={item.url === "/"}
          className={({ isActive }) =>
            `flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-all ${
              isActive ? "text-accent" : "text-primary/60"
            }`
          }
        >
          <item.icon className="h-5 w-5" />
          <span className="text-[10px] font-medium">{item.title}</span>
        </NavLink>
      ))}
    </div>
  </nav>
);

export default MobileNav;

import { ReactNode } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import MobileNav from "@/components/MobileNav";
import StarField from "@/components/StarField";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

const AppLayout = ({ children }: { children: ReactNode }) => {
  const { signOut, user } = useAuth();

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full relative">
        <StarField />
        <div className="hidden md:block">
          <AppSidebar />
        </div>
        <div className="flex-1 flex flex-col h-screen overflow-hidden">
          <header className="h-12 flex items-center justify-between border-b border-border/30 px-4 glass-card-strong z-10 shrink-0">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="hidden md:flex text-primary" />
              <span className="font-display text-xs tracking-widest text-primary md:hidden text-glow-blue">
                SKYFORGE
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground hidden sm:block">
                {user?.email}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={signOut}
                className="text-muted-foreground hover:text-destructive"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </header>
          <main className="flex-1 min-h-0 overflow-auto pb-20 md:pb-0">
            {children}
          </main>
        </div>
        <MobileNav />
      </div>
    </SidebarProvider>
  );
};

export default AppLayout;

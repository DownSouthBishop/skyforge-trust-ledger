import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { listProjects, getActiveProjectId, setActiveProjectId, type ProjectRow } from "@/lib/project-context";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function ProjectSelector({ className }: { className?: string }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [active, setActive] = useState<string | null>(getActiveProjectId());

  useEffect(() => {
    if (!user) return;
    listProjects(user.id).then(setProjects);
    const h = () => setActive(getActiveProjectId());
    window.addEventListener("active-project-changed", h);
    return () => window.removeEventListener("active-project-changed", h);
  }, [user?.id]);

  if (!user) return null;

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <span className="text-xs uppercase tracking-widest text-primary/60">Project</span>
      <Select
        value={active ?? "__none__"}
        onValueChange={(v) => { const id = v === "__none__" ? null : v; setActive(id); setActiveProjectId(id); }}
      >
        <SelectTrigger className="h-8 w-[200px] bg-card/40 border-border/50 text-xs">
          <SelectValue placeholder="No project" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No project</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}


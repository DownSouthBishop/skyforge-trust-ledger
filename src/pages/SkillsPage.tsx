import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChevronRight, ChevronDown, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";

interface Skill {
  id: string; skill_name: string; category: string; description: string;
  agent_slug: string | null; enabled: boolean;
}
interface Agent { id: string; slug: string; name: string; avatar_emoji: string | null }

export default function SkillsPage() {
  const { user } = useAuth();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [category, setCategory] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!user) return;
      const [{ data: s }, { data: a }] = await Promise.all([
        supabase.from("agent_skills").select("id,skill_name,category,description,agent_slug,enabled").eq("user_id", user.id).order("category").order("skill_name"),
        supabase.from("skyforge_agents").select("id,slug,name,avatar_emoji").eq("user_id", user.id).eq("is_active", true).order("name"),
      ]);
      setSkills((s as Skill[]) ?? []);
      setAgents((a as Agent[]) ?? []);
    })();
  }, [user]);

  const categories = useMemo(() => ["All", ...Array.from(new Set(skills.map(s => s.category))).sort()], [skills]);

  const filtered = skills.filter(s =>
    (category === "All" || s.category === category) &&
    (!search.trim() || s.skill_name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase()))
  );

  const agentBySlug = Object.fromEntries(agents.map(a => [a.slug, a]));
  const enabledCount = skills.filter(s => s.enabled).length;

  async function toggleEnabled(skill: Skill) {
    const next = !skill.enabled;
    setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled: next } : s));
    const { error } = await supabase.from("agent_skills").update({ enabled: next, updated_at: new Date().toISOString() }).eq("id", skill.id);
    if (error) {
      setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, enabled: !next } : s));
      toast.error(error.message);
    }
  }

  async function setAgent(skill: Skill, slug: string | null) {
    setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, agent_slug: slug } : s));
    const { error } = await supabase.from("agent_skills").update({ agent_slug: slug, updated_at: new Date().toISOString() }).eq("id", skill.id);
    if (error) toast.error(error.message);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="font-display text-lg tracking-widest text-primary flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> SKILLS
        </h1>
        <p className="text-xs text-muted-foreground/60 mt-0.5">
          {skills.length} skills · {enabledCount} active. Toggle a skill on for an agent and it shapes how that agent communicates until you turn it back off.
        </p>
      </div>

      <div className="flex gap-2">
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="bg-secondary/20 border border-border/30 rounded-md px-3 py-2 text-xs text-foreground outline-none"
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search skills…" className="pl-8 text-xs" />
        </div>
      </div>

      <div className="space-y-1">
        {filtered.length === 0 && <p className="text-xs text-muted-foreground text-center py-8">No skills match.</p>}
        {filtered.map(skill => {
          const isOpen = expanded === skill.id;
          const linkedAgent = skill.agent_slug ? agentBySlug[skill.agent_slug] : null;
          return (
            <div key={skill.id} className="border border-border/20 rounded-lg overflow-hidden bg-secondary/5">
              <button
                onClick={() => setExpanded(isOpen ? null : skill.id)}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-secondary/10"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="text-xs font-medium truncate">{skill.skill_name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/50 shrink-0">{skill.category}</span>
                {linkedAgent && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent shrink-0">
                    {linkedAgent.avatar_emoji ?? "🤖"} {linkedAgent.name}
                  </span>
                )}
                <span className="ml-auto shrink-0" onClick={e => e.stopPropagation()}>
                  <Switch checked={skill.enabled} onCheckedChange={() => toggleEnabled(skill)} disabled={!skill.agent_slug} />
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-border/20 px-3 py-3 space-y-2">
                  <p className="text-xs text-foreground/70 leading-relaxed">{skill.description || "No description."}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Connected to</span>
                    <select
                      value={skill.agent_slug ?? ""}
                      onChange={e => setAgent(skill, e.target.value || null)}
                      className="bg-secondary/20 border border-border/30 rounded-md px-2 py-1 text-xs text-foreground outline-none"
                    >
                      <option value="">Unassigned</option>
                      {agents.map(a => <option key={a.slug} value={a.slug}>{a.avatar_emoji ?? "🤖"} {a.name}</option>)}
                    </select>
                    {!skill.agent_slug && <span className="text-[10px] text-muted-foreground/40">Connect to an agent before it can be turned on.</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

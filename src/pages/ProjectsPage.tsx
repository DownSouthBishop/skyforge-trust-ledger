import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = _supabase as any;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, ArrowRight } from "lucide-react";

const ONBOARDING_QS = [
  { key: "customer_description", q: "Who is your customer exactly?" },
  { key: "problem_solved", q: "What problem do you solve for them?" },
  { key: "revenue_model", q: "How do you make money?" },
  { key: "what_was_tried", q: "What have you already tried?" },
  { key: "win_in_90_days", q: "What does winning look like in 90 days?" },
] as const;

interface Project { id: string; name: string; description: string | null; status: string | null; }

export default function ProjectsPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [pulses, setPulses] = useState<Record<string, "green"|"yellow"|"red">>({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [onboardProject, setOnboardProject] = useState<Project | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState("");

  const load = async () => {
    if (!user) return;
    const { data } = await supabase.from("business_projects").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    const list = (data ?? []) as Project[];
    setProjects(list);
    // pulses
    const pmap: Record<string, "green"|"yellow"|"red"> = {};
    for (const p of list) {
      const [bn, fin] = await Promise.all([
        supabase.from("project_bottlenecks").select("id").eq("project_id", p.id).eq("resolved", false),
        supabase.from("project_financials").select("id").eq("project_id", p.id).limit(1),
      ]);
      const hasBn = (bn.data ?? []).length > 0;
      const hasActivity = (fin.data ?? []).length > 0;
      pmap[p.id] = !hasBn && hasActivity ? "green" : hasBn && !hasActivity ? "red" : "yellow";
    }
    setPulses(pmap);
  };
  useEffect(() => { load(); }, [user]);

  const createProject = async () => {
    if (!user || !newName.trim()) return;
    const { data, error } = await supabase.from("business_projects")
      .insert({ user_id: user.id, name: newName.trim(), description: newDesc.trim() || null })
      .select().single();
    if (error) return;
    setCreating(false);
    setNewName(""); setNewDesc("");
    setOnboardProject(data);
    setQIdx(0); setAnswers({}); setAnswer("");
    await load();
  };

  const submitAnswer = async () => {
    if (!onboardProject || !user || !answer.trim()) return;
    const q = ONBOARDING_QS[qIdx];
    const next = { ...answers, [q.key]: answer.trim() };
    setAnswers(next);
    // log to project_memory as system/onboarding
    await supabase.from("project_memory").insert({
      project_id: onboardProject.id, user_id: user.id,
      agent: "system", memory_type: "onboarding",
      content: `Q: ${q.q}\nA: ${answer.trim()}`,
    });
    setAnswer("");
    if (qIdx + 1 < ONBOARDING_QS.length) {
      setQIdx(qIdx + 1);
    } else {
      await supabase.from("project_onboarding").insert({
        project_id: onboardProject.id, user_id: user.id, ...next,
      });
      const pid = onboardProject.id;
      setOnboardProject(null);
      nav(`/projects/${pid}`);
    }
  };

  const dot = (c: "green"|"yellow"|"red") =>
    c === "green" ? "bg-emerald-500" : c === "red" ? "bg-red-500" : "bg-amber-500";

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-primary tracking-widest">PROJECTS</h1>
          <p className="text-sm text-muted-foreground">Each project is a business. Atlas, Linda and Janus operate inside it.</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2"><Plus className="h-4 w-4" /> New Project</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((p) => (
          <Card key={p.id} className="glass-card hover:border-primary/40 cursor-pointer transition" onClick={() => nav(`/projects/${p.id}`)}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${dot(pulses[p.id] ?? "yellow")} animate-pulse`} />
                  {p.name}
                </CardTitle>
                <Badge variant="outline" className="text-xs">{p.status ?? "active"}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground min-h-[40px]">{p.description ?? "No description yet."}</p>
              <div className="flex justify-end mt-2"><ArrowRight className="h-4 w-4 text-primary/60" /></div>
            </CardContent>
          </Card>
        ))}
        {projects.length === 0 && (
          <Card className="glass-card col-span-full">
            <CardContent className="p-8 text-center text-muted-foreground">
              No projects yet. Click <strong>New Project</strong> to begin.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="bg-card">
          <DialogHeader><DialogTitle>New Project</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Textarea placeholder="One-line description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={createProject} disabled={!newName.trim()}>Create & Begin Onboarding</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Onboarding chat */}
      <Dialog open={!!onboardProject} onOpenChange={(o) => { if (!o) setOnboardProject(null); }}>
        <DialogContent className="bg-card max-w-xl">
          <DialogHeader>
            <DialogTitle>Atlas — onboarding {onboardProject?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">Question {qIdx + 1} of {ONBOARDING_QS.length}</div>
            <div className="p-4 rounded-lg bg-primary/5 border border-primary/20 text-primary">
              {ONBOARDING_QS[qIdx]?.q}
            </div>
            <Textarea
              autoFocus
              placeholder="Your answer…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitAnswer(); }}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button onClick={submitAnswer} disabled={!answer.trim()}>
              {qIdx + 1 === ONBOARDING_QS.length ? "Finish" : "Next"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

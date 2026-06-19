import { useEffect, useMemo, useRef, useState } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Plus, Trash2, Mic, X, CalendarIcon } from "lucide-react";

type Tab = "calendar" | "goals";
type Importance = "high" | "medium" | "low";

interface Journal { id: string; date: string; title: string; context: string | null; importance: Importance }
interface Goal { id: string; title: string; context: string | null; importance: Importance; status: string }
interface Objective { id: string; goal_id: string; title: string; letter: string; context: string | null; status: string }
interface Task { id: string; objective_id: string; title: string; code: string; context: string | null; importance: Importance; status: string; due_date: string | null }

const impColor = (i: Importance) => i === "high" ? "text-red-400" : i === "low" ? "text-green-400" : "text-yellow-400";
const impDot = (i: Importance) => i === "high" ? "bg-red-400" : i === "low" ? "bg-green-400" : "bg-yellow-400";
const impBadge = (i: Importance) => i === "high" ? "destructive" : i === "low" ? "secondary" : "default";
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default function DossierPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("calendar");
  const [uid, setUid] = useState<string>("");
  const [journals, setJournals] = useState<Journal[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [newEntryTitle, setNewEntryTitle] = useState("");
  const [newEntryContext, setNewEntryContext] = useState("");
  const [newEntryImportance, setNewEntryImportance] = useState<Importance>("medium");
  const year = new Date().getFullYear();

  useEffect(() => {
    let userId = "";
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      userId = user.id;
      setUid(user.id);
      await reload(user.id);

      const channel = supabase
        .channel(`dossier_realtime:${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'journal_entries', filter: `user_id=eq.${user.id}` }, () => reload(userId))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'goals', filter: `user_id=eq.${user.id}` }, () => reload(userId))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${user.id}` }, () => reload(userId))
        .subscribe();

      return () => { void supabase.removeChannel(channel); };
    })();
  }, []);

  async function reload(userId: string) {
    const [j, g, o, t] = await Promise.all([
      supabase.from("journal_entries").select("*").eq("user_id", userId),
      supabase.from("goals").select("*").eq("user_id", userId).order("created_at"),
      supabase.from("objectives").select("*").eq("user_id", userId).order("letter"),
      supabase.from("tasks").select("*").eq("user_id", userId).order("code"),
    ]);
    setJournals((j.data ?? []) as Journal[]);
    setGoals((g.data ?? []) as Goal[]);
    setObjectives((o.data ?? []) as Objective[]);
    setTasks((t.data ?? []) as Task[]);
  }

  // ── Calendar helpers ────────────────────────────────────────────────────
  const journalsByDay = useMemo(() => {
    const m: Record<string, Journal[]> = {};
    journals.forEach(j => { (m[j.date] ||= []).push(j); });
    return m;
  }, [journals]);
  const tasksByDay = useMemo(() => {
    const m: Record<string, Task[]> = {};
    tasks.forEach(t => { if (t.due_date) (m[t.due_date] ||= []).push(t); });
    return m;
  }, [tasks]);

  function startVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast({ title: "Voice not supported in this browser" }); return; }
    const r = new SR(); r.lang = "en-US"; r.interimResults = false;
    r.onresult = (e: any) => setNewEntryTitle(e.results[0][0].transcript);
    r.start();
  }

  async function addJournal() {
    if (!newEntryTitle.trim() || !selectedDate) return;
    const { error } = await supabase.from("journal_entries").insert({
      user_id: uid, date: selectedDate, title: newEntryTitle, context: newEntryContext || null, importance: newEntryImportance,
    });
    if (error) return toast({ title: "Failed", description: error.message, variant: "destructive" });
    setNewEntryTitle(""); setNewEntryContext(""); setNewEntryImportance("medium");
    reload(uid);
  }
  async function deleteJournal(id: string) {
    await supabase.from("journal_entries").delete().eq("id", id);
    reload(uid);
  }
  async function rescheduleTask(id: string, date: string) {
    await supabase.from("tasks").update({ due_date: date }).eq("id", id);
    reload(uid);
  }
  async function toggleTask(t: Task) {
    const next = t.status === "pending" ? "complete" : "pending";
    await supabase.from("tasks").update({ status: next }).eq("id", t.id);
    // cascade objective + goal completion
    const updated = tasks.map(x => x.id === t.id ? { ...x, status: next } : x);
    const objTasks = updated.filter(x => x.objective_id === t.objective_id);
    const objAllDone = objTasks.length > 0 && objTasks.every(x => x.status === "complete");
    await supabase.from("objectives").update({ status: objAllDone ? "complete" : "active" }).eq("id", t.objective_id);
    const obj = objectives.find(o => o.id === t.objective_id);
    if (obj) {
      const goalObjs = objectives.map(o => o.id === obj.id ? { ...o, status: objAllDone ? "complete" : "active" } : o)
        .filter(o => o.goal_id === obj.goal_id);
      const goalDone = goalObjs.length > 0 && goalObjs.every(o => o.status === "complete");
      await supabase.from("goals").update({ status: goalDone ? "complete" : "active" }).eq("id", obj.goal_id);
    }
    reload(uid);
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full max-w-7xl mx-auto px-4 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-primary">Dossier</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Calendar, journal, goals.</p>
      </div>

      <div className="flex gap-1 border-b border-border/30 shrink-0">
        {(["calendar", "goals"] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t ? "border-accent text-accent" : "border-transparent text-muted-foreground hover:text-primary"
            }`}>{t}</button>
        ))}
      </div>

      {tab === "calendar" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 12 }).map((_, m) => (
              <MonthGrid key={m} year={year} month={m}
                journalsByDay={journalsByDay} tasksByDay={tasksByDay}
                onPick={setSelectedDate} />
            ))}
          </div>
        </div>
      )}

      {tab === "goals" && (
        <GoalsTree uid={uid} goals={goals} objectives={objectives} tasks={tasks}
          onReload={() => reload(uid)} onToggleTask={toggleTask} onReschedule={rescheduleTask} />
      )}

      {selectedDate && (
        <DayPanel date={selectedDate} onClose={() => setSelectedDate(null)}
          journals={journalsByDay[selectedDate] ?? []}
          tasks={tasksByDay[selectedDate] ?? []}
          objectives={objectives} goals={goals}
          newEntryTitle={newEntryTitle} setNewEntryTitle={setNewEntryTitle}
          newEntryContext={newEntryContext} setNewEntryContext={setNewEntryContext}
          newEntryImportance={newEntryImportance} setNewEntryImportance={setNewEntryImportance}
          onVoice={startVoice} onAdd={addJournal} onDelete={deleteJournal}
          onToggleTask={toggleTask} onReschedule={rescheduleTask} />
      )}
    </div>
  );
}

// ── Month grid ────────────────────────────────────────────────────────────
function MonthGrid({ year, month, journalsByDay, tasksByDay, onPick }:{
  year: number; month: number;
  journalsByDay: Record<string, Journal[]>; tasksByDay: Record<string, Task[]>;
  onPick: (d: string) => void;
}) {
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const offset = first.getDay();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const monthName = first.toLocaleString("en-US", { month: "long" });

  return (
    <div className="border border-border/40 rounded-lg p-2 bg-card/40">
      <div className="text-sm font-semibold text-primary mb-2 px-1">{monthName}</div>
      <div className="grid grid-cols-7 text-[9px] text-muted-foreground mb-1">
        {["S","M","T","W","T","F","S"].map((d,i) => <div key={i} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((c, i) => {
          if (!c) return <div key={i} className="h-14" />;
          const key = ymd(c);
          const js = journalsByDay[key] ?? [];
          const ts = tasksByDay[key] ?? [];
          const preview = [...js.slice(0,1).map(j => ({ text: j.title, cls: "text-white" })),
                           ...ts.slice(0,1).map(t => ({ text: t.code, cls: impColor(t.importance) }))].slice(0,2);
          return (
            <button key={i} onClick={() => onPick(key)}
              className="h-14 text-[10px] border border-border/20 rounded p-0.5 hover:bg-accent/10 text-left overflow-hidden">
              <div className="text-muted-foreground">{c.getDate()}</div>
              {preview.map((p, idx) => (
                <div key={idx} className={`truncate ${p.cls}`}>{p.text}</div>
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Day side panel ────────────────────────────────────────────────────────
function DayPanel(props: {
  date: string; onClose: () => void;
  journals: Journal[]; tasks: Task[]; objectives: Objective[]; goals: Goal[];
  newEntryTitle: string; setNewEntryTitle: (s: string) => void;
  newEntryContext: string; setNewEntryContext: (s: string) => void;
  newEntryImportance: Importance; setNewEntryImportance: (i: Importance) => void;
  onVoice: () => void; onAdd: () => void; onDelete: (id: string) => void;
  onToggleTask: (t: Task) => void; onReschedule: (id: string, date: string) => void;
}) {
  const { date, journals, tasks, objectives, goals } = props;
  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[420px] bg-background border-l border-border z-50 overflow-y-auto p-4 space-y-4 shadow-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-primary">{new Date(date + "T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</h2>
        <Button size="icon" variant="ghost" onClick={props.onClose}><X className="w-4 h-4" /></Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-muted-foreground uppercase tracking-wider">Journal</div>
        {journals.map(j => (
          <div key={j.id} className="border border-border/40 rounded p-2 flex justify-between items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-primary">{j.title}</span>
                <Badge variant={impBadge(j.importance) as any} className="text-[10px]">{j.importance}</Badge>
              </div>
              {j.context && <div className="text-xs text-muted-foreground mt-1">{j.context}</div>}
            </div>
            <button onClick={() => props.onDelete(j.id)} className="text-muted-foreground hover:text-destructive">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <div className="space-y-2 pt-2 border-t border-border/30">
          <div className="flex gap-2">
            <Input value={props.newEntryTitle} onChange={e => props.setNewEntryTitle(e.target.value)} placeholder="New entry title" className="text-sm" />
            <Button size="icon" variant="outline" onClick={props.onVoice}><Mic className="w-4 h-4" /></Button>
          </div>
          <Textarea value={props.newEntryContext} onChange={e => props.setNewEntryContext(e.target.value)} placeholder="Context (optional)" className="text-sm min-h-[60px]" />
          <div className="flex gap-2 items-center">
            <select value={props.newEntryImportance} onChange={e => props.setNewEntryImportance(e.target.value as Importance)}
              className="text-xs bg-background border border-border rounded px-2 py-1">
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
            <Button size="sm" onClick={props.onAdd}><Plus className="w-3.5 h-3.5 mr-1" />Add</Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-muted-foreground uppercase tracking-wider">Tasks Due</div>
        {tasks.length === 0 && <div className="text-xs text-muted-foreground italic">None.</div>}
        {tasks.map(t => {
          const obj = objectives.find(o => o.id === t.objective_id);
          const goal = obj ? goals.find(g => g.id === obj.goal_id) : null;
          return (
            <div key={t.id} className="border border-border/40 rounded p-2 space-y-1">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={t.status === "complete"} onChange={() => props.onToggleTask(t)} />
                <span className="text-xs font-mono text-accent">{t.code}</span>
                <span className="text-sm text-primary flex-1">{t.title}</span>
                <Badge variant={impBadge(t.importance) as any} className="text-[10px]">{t.importance}</Badge>
              </div>
              {goal && <div className="text-[10px] text-muted-foreground">{goal.title} / {obj?.title}</div>}
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-6 text-[10px]"><CalendarIcon className="w-3 h-3 mr-1" />Reschedule</Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
                  <CalendarPicker mode="single" selected={t.due_date ? new Date(t.due_date+"T12:00:00") : undefined}
                    onSelect={(d) => d && props.onReschedule(t.id, ymd(d))}
                    className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Goals tree ────────────────────────────────────────────────────────────
function GoalsTree({ uid, goals, objectives, tasks, onReload, onToggleTask, onReschedule }:{
  uid: string; goals: Goal[]; objectives: Objective[]; tasks: Task[];
  onReload: () => void; onToggleTask: (t: Task) => void; onReschedule: (id: string, d: string) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [gTitle, setGTitle] = useState(""); const [gCtx, setGCtx] = useState(""); const [gImp, setGImp] = useState<Importance>("medium");
  const [objModalGoal, setObjModalGoal] = useState<Goal | null>(null);
  const [oTitle, setOTitle] = useState("");
  const [taskModalObj, setTaskModalObj] = useState<Objective | null>(null);
  const [tTitle, setTTitle] = useState(""); const [tCtx, setTCtx] = useState(""); const [tImp, setTImp] = useState<Importance>("medium"); const [tDue, setTDue] = useState<Date | undefined>();

  async function addGoal() {
    if (!gTitle.trim()) return;
    const { error } = await supabase.from("goals").insert({ user_id: uid, title: gTitle, context: gCtx || null, importance: gImp });
    if (error) return toast({ title:"Failed", description:error.message, variant:"destructive" });
    setShowGoalModal(false); setGTitle(""); setGCtx(""); setGImp("medium"); onReload();
  }
  async function addObjective() {
    if (!objModalGoal || !oTitle.trim()) return;
    const existing = objectives.filter(o => o.goal_id === objModalGoal.id);
    const letter = String.fromCharCode(65 + existing.length);
    const { error } = await supabase.from("objectives").insert({ user_id: uid, goal_id: objModalGoal.id, title: oTitle, letter });
    if (error) return toast({ title:"Failed", description:error.message, variant:"destructive" });
    setObjModalGoal(null); setOTitle(""); onReload();
  }
  async function addTask() {
    if (!taskModalObj || !tTitle.trim()) return;
    const existing = tasks.filter(t => t.objective_id === taskModalObj.id);
    const code = `${taskModalObj.letter}${existing.length + 1}`;
    const { error } = await supabase.from("tasks").insert({
      user_id: uid, objective_id: taskModalObj.id, title: tTitle, code,
      context: tCtx || null, importance: tImp, due_date: tDue ? ymd(tDue) : null,
    });
    if (error) return toast({ title:"Failed", description:error.message, variant:"destructive" });
    setTaskModalObj(null); setTTitle(""); setTCtx(""); setTImp("medium"); setTDue(undefined); onReload();
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowGoalModal(true)}><Plus className="w-3.5 h-3.5 mr-1" />Add Goal</Button>
      </div>
      {goals.map(g => {
        const gObjs = objectives.filter(o => o.goal_id === g.id);
        const gTasks = tasks.filter(t => gObjs.some(o => o.id === t.objective_id));
        const done = gTasks.filter(t => t.status === "complete").length;
        const pct = gTasks.length ? Math.round((done / gTasks.length) * 100) : 0;
        const isOpen = open[g.id] ?? true;
        return (
          <div key={g.id} className="border border-border/40 rounded-lg bg-card/40">
            <div className="flex items-center gap-2 p-3">
              <button onClick={() => setOpen({ ...open, [g.id]: !isOpen })}>
                {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              <span className="text-lg">🎯</span>
              <span className="text-sm font-semibold text-primary flex-1">{g.title}</span>
              <Badge variant={g.status === "complete" ? "secondary" : "default"} className="text-[10px]">{g.status}</Badge>
              <span className="text-xs text-muted-foreground">{pct}%</span>
            </div>
            {isOpen && (
              <div className="pl-8 pr-3 pb-3 space-y-2">
                {gObjs.map(o => {
                  const oTasks = tasks.filter(t => t.objective_id === o.id);
                  const oKey = `o-${o.id}`;
                  const oOpen = open[oKey] ?? true;
                  return (
                    <div key={o.id} className="border-l-2 border-border/30 pl-3">
                      <div className="flex items-center gap-2 py-1">
                        <button onClick={() => setOpen({ ...open, [oKey]: !oOpen })}>
                          {oOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <span>📌</span>
                        <span className="text-sm text-primary flex-1">Objective {o.letter}: {o.title}</span>
                        <Badge variant={o.status === "complete" ? "secondary" : "default"} className="text-[10px]">{o.status}</Badge>
                      </div>
                      {oOpen && (
                        <div className="pl-6 space-y-1">
                          {oTasks.map(t => (
                            <div key={t.id} className="flex items-center gap-2 text-xs py-1">
                              <span className="font-mono text-accent w-6">{t.code}</span>
                              <span className="flex-1 text-primary">{t.title}</span>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button className="text-muted-foreground hover:text-primary">{t.due_date ?? "—"}</button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0 pointer-events-auto" align="end">
                                  <CalendarPicker mode="single" selected={t.due_date ? new Date(t.due_date+"T12:00:00") : undefined}
                                    onSelect={(d) => d && onReschedule(t.id, ymd(d))}
                                    className="p-3 pointer-events-auto" />
                                </PopoverContent>
                              </Popover>
                              <span className={`w-2 h-2 rounded-full ${impDot(t.importance)}`} />
                              <input type="checkbox" checked={t.status === "complete"} onChange={() => onToggleTask(t)} />
                            </div>
                          ))}
                          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setTaskModalObj(o)}>
                            <Plus className="w-3 h-3 mr-1" />Add Task
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <Button size="sm" variant="ghost" className="text-xs" onClick={() => setObjModalGoal(g)}>
                  <Plus className="w-3 h-3 mr-1" />Add Objective
                </Button>
              </div>
            )}
          </div>
        );
      })}

      <Dialog open={showGoalModal} onOpenChange={setShowGoalModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Goal</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={gTitle} onChange={e => setGTitle(e.target.value)} placeholder="Goal title" />
            <Textarea value={gCtx} onChange={e => setGCtx(e.target.value)} placeholder="Context" />
            <select value={gImp} onChange={e => setGImp(e.target.value as Importance)} className="w-full bg-background border rounded px-2 py-1 text-sm">
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </div>
          <DialogFooter><Button onClick={addGoal}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!objModalGoal} onOpenChange={(v) => !v && setObjModalGoal(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Objective</DialogTitle></DialogHeader>
          <Input value={oTitle} onChange={e => setOTitle(e.target.value)} placeholder="Objective title" />
          <DialogFooter><Button onClick={addObjective}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!taskModalObj} onOpenChange={(v) => !v && setTaskModalObj(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Task</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={tTitle} onChange={e => setTTitle(e.target.value)} placeholder="Task title" />
            <Textarea value={tCtx} onChange={e => setTCtx(e.target.value)} placeholder="Context" />
            <select value={tImp} onChange={e => setTImp(e.target.value as Importance)} className="w-full bg-background border rounded px-2 py-1 text-sm">
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start"><CalendarIcon className="w-4 h-4 mr-2" />{tDue ? ymd(tDue) : "Pick due date"}</Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
                <CalendarPicker mode="single" selected={tDue} onSelect={setTDue} className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
          </div>
          <DialogFooter><Button onClick={addTask}>Create</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

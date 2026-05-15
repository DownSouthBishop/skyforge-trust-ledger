import { useEffect, useMemo, useState } from "react";
import {
  Target, Flame, Copy, Trash2, X, Tag, FileText, BookOpen,
  TrendingUp, ShieldAlert, Sparkles, ListOrdered, Brain,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

interface ArsenalItem {
  id: string;
  title: string;
  type: string;
  content: string;
  use_count: number;
  win_count: number;
  source: string;
}

type CategoryKey = "setups" | "playbooks" | "risk-rules" | "thesis" | "criteria" | "directives" | "reference";

const CATEGORIES: { key: CategoryKey; label: string; icon: typeof Target; keywords: RegExp }[] = [
  { key: "setups",      label: "Setups",      icon: TrendingUp,  keywords: /\b(setup|entry|pattern|breakout|pullback|reversal|signal)\b/i },
  { key: "playbooks",   label: "Playbooks",   icon: BookOpen,    keywords: /\b(playbook|system|strategy|approach|method|framework)\b/i },
  { key: "risk-rules",  label: "Risk Rules",  icon: ShieldAlert, keywords: /\b(risk|stop.?loss|position.?size|drawdown|limit|max|rule)\b/i },
  { key: "thesis",      label: "Templates",   icon: Brain,       keywords: /\b(thesis|template|analysis|research|due.?diligence)\b/i },
  { key: "criteria",    label: "Criteria",    icon: ListOrdered, keywords: /\b(criteria|checklist|filter|screen|condition|requirement)\b/i },
  { key: "directives",  label: "Directives",  icon: Flame,       keywords: /\b(directive|protocol|sop|process|step|procedure)\b/i },
  { key: "reference",   label: "Reference",   icon: FileText,    keywords: /^$/ }, // fallback bucket
];

const categorize = (it: ArsenalItem): CategoryKey => {
  // Honor explicit type if it matches a category
  const t = (it.type || "").toLowerCase();
  const direct = CATEGORIES.find((c) => c.key === t);
  if (direct) return direct.key;
  // Otherwise infer from title + content
  const haystack = `${it.title}\n${it.content}`;
  for (const c of CATEGORIES) {
    if (c.key === "assets") continue;
    if (c.keywords.test(haystack)) return c.key;
  }
  return "assets";
};

const ArsenalPage = () => {
  const { user } = useAuth();
  const [items, setItems] = useState<ArsenalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | CategoryKey>("all");
  const [openItem, setOpenItem] = useState<ArsenalItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ArsenalItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("arsenal_items")
      .select("*")
      .eq("user_id", user!.id);
    const rows = (data ?? []) as ArsenalItem[];
    rows.sort((a, b) => {
      const ar = a.use_count > 0 ? a.win_count / a.use_count : -1;
      const br = b.use_count > 0 ? b.win_count / b.use_count : -1;
      return br - ar;
    });
    setItems(rows);
    setLoading(false);
  };

  const grouped = useMemo(() => {
    const map: Record<CategoryKey, ArsenalItem[]> = {
      setups: [], playbooks: [], "risk-rules": [], thesis: [], criteria: [], directives: [], reference: [],
    };
    for (const it of items) map[categorize(it)].push(it);
    return map;
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const cat of CATEGORIES) c[cat.key] = grouped[cat.key].length;
    return c;
  }, [grouped, items]);

  const visibleItems = useMemo(() => {
    if (activeTab === "all") return items;
    return grouped[activeTab];
  }, [activeTab, items, grouped]);

  const handleCopy = async (it: ArsenalItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await navigator.clipboard.writeText(it.content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    const { error } = await supabase
      .from("arsenal_items")
      .delete()
      .eq("id", confirmDelete.id);
    setDeleting(false);
    if (error) {
      toast.error("Delete failed");
      return;
    }
    setItems((prev) => prev.filter((x) => x.id !== confirmDelete.id));
    if (openItem?.id === confirmDelete.id) setOpenItem(null);
    setConfirmDelete(null);
    toast.success("Removed from arsenal");
  };

  const renderCard = (it: ArsenalItem) => {
    const wins = it.win_count;
    const uses = it.use_count;
    const winRate = uses > 0 ? (wins / uses) * 100 : null;
    const cat = categorize(it);
    const catMeta = CATEGORIES.find((c) => c.key === cat)!;
    const Icon = catMeta.icon;
    return (
      <button
        key={it.id}
        onClick={() => setOpenItem(it)}
        className="glass-card p-5 space-y-3 text-left hover:border-accent/40 hover:bg-primary/5 transition-colors group"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <Icon className="h-4 w-4 text-accent mt-0.5 shrink-0" />
            <h3 className="text-base font-display tracking-wide text-foreground truncate">
              {it.title}
            </h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider">
              {catMeta.label}
            </span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
          {it.content}
        </p>
        <div className="flex items-center justify-between pt-2 border-t border-border/30">
          {uses > 0 ? (
            <div className="flex items-center gap-2">
              <Flame className="h-3 w-3 text-accent" />
              <span className="text-xs text-accent font-medium">
                {wins} of {uses} closes
                {winRate !== null && ` · ${Math.round(winRate)}%`}
              </span>
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">Unused</span>
          )}
          <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => handleCopy(it, e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleCopy(it);
                }
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
              aria-label="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(it);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmDelete(it);
                }
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive cursor-pointer"
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">STRATEGIES</h1>
        <p className="text-xs text-muted-foreground/60 mt-0.5">Trading playbooks · Setups · Risk rules · Templates</p>
      </div>

      {loading && <div className="text-muted-foreground text-sm">Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="glass-card p-10 flex flex-col items-center justify-center text-center space-y-6 min-h-[400px] relative overflow-hidden">
          <img
            src={skyforgeEagle}
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-10"
            loading="lazy"
          />
          <div className="relative z-10 space-y-4">
            <Target className="h-16 w-16 text-primary/30 mx-auto" />
            <h2 className="text-lg font-display tracking-widest text-primary/60">EMPTY</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Atlas will save trading playbooks, setups, risk rules, and thesis templates here as you work together.
            </p>
          </div>
        </div>
      )}

      {!loading && items.length > 0 && (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="flex-wrap h-auto bg-secondary/40 border border-border/30">
            <TabsTrigger value="all" className="data-[state=active]:bg-primary/15 data-[state=active]:text-primary">
              All <span className="ml-1.5 text-[10px] opacity-60">{counts.all}</span>
            </TabsTrigger>
            {CATEGORIES.map((c) => {
              const Icon = c.icon;
              const n = counts[c.key] ?? 0;
              if (n === 0 && c.key !== "reference") return null;
              return (
                <TabsTrigger
                  key={c.key}
                  value={c.key}
                  className="data-[state=active]:bg-primary/15 data-[state=active]:text-primary"
                >
                  <Icon className="h-3.5 w-3.5 mr-1.5" />
                  {c.label}
                  <span className="ml-1.5 text-[10px] opacity-60">{n}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value={activeTab} className="mt-4">
            {visibleItems.length === 0 ? (
              <div className="glass-card p-8 text-center text-sm text-muted-foreground">
                Nothing in this category yet.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {visibleItems.map(renderCard)}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Detail dialog */}
      <Dialog open={!!openItem} onOpenChange={(o) => !o && setOpenItem(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-card border-border/50">
          {openItem && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between gap-3 pr-8">
                  <div className="space-y-2 min-w-0">
                    <DialogTitle className="font-display tracking-wide text-lg text-foreground">
                      {openItem.title}
                    </DialogTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider inline-flex items-center gap-1">
                        <Tag className="h-3 w-3" />
                        {CATEGORIES.find((c) => c.key === categorize(openItem))?.label}
                      </span>
                      {openItem.use_count > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/40 text-accent uppercase tracking-wider inline-flex items-center gap-1">
                          <Flame className="h-3 w-3" />
                          {openItem.win_count}/{openItem.use_count}
                        </span>
                      )}
                      {openItem.source && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-border/40 text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          {openItem.source.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto py-4 px-1">
                <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90 leading-relaxed">
                  {openItem.content}
                </pre>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/30">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirmDelete(openItem);
                  }}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                >
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </Button>
                <Button size="sm" onClick={() => handleCopy(openItem)}>
                  <Copy className="h-4 w-4 mr-2" /> Copy
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.title} will be permanently removed from your arsenal. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ArsenalPage;

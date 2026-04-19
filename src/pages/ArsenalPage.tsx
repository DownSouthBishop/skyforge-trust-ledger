import { useEffect, useState } from "react";
import { Shield, Flame } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
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

const ArsenalPage = () => {
  const { user } = useAuth();
  const [items, setItems] = useState<ArsenalItem[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
        ARSENAL
      </h1>

      {loading && (
        <div className="text-muted-foreground text-sm">Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="glass-card p-10 flex flex-col items-center justify-center text-center space-y-6 min-h-[400px] relative overflow-hidden">
          <img
            src={skyforgeEagle}
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-10"
            loading="lazy"
          />
          <div className="relative z-10 space-y-4">
            <Shield className="h-16 w-16 text-primary/30 mx-auto" />
            <h2 className="text-lg font-display tracking-widest text-primary/60">
              EMPTY
            </h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Forge will save scripts, sequences, and pricing structures here as you work together.
            </p>
          </div>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((it) => {
            const wins = it.win_count;
            const uses = it.use_count;
            const winRate = uses > 0 ? (wins / uses) * 100 : null;
            return (
              <div key={it.id} className="glass-card p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-display tracking-wide text-foreground">
                    {it.title}
                  </h3>
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider">
                    {it.type}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
                  {it.content}
                </p>
                {uses > 0 && (
                  <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                    <Flame className="h-3 w-3 text-accent" />
                    <span className="text-xs text-accent font-medium">
                      {wins} of {uses} closes
                      {winRate !== null && ` · ${Math.round(winRate)}%`}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ArsenalPage;

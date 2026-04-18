import { useEffect, useState } from "react";
import { Shield, Flame } from "lucide-react";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";
import { supabase } from "@/integrations/supabase/client";

type ArsenalItem = {
  id: string;
  title: string;
  type: string;
  content: string;
  use_count: number;
  win_count: number;
  created_at: string;
};

const ArsenalPage = () => {
  const [items, setItems] = useState<ArsenalItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("arsenal_items")
        .select("id,title,type,content,use_count,win_count,created_at");
      if (error) {
        console.error(error);
      } else if (data) {
        const sorted = [...data].sort((a, b) => {
          const ar = a.use_count > 0 ? a.win_count / a.use_count : -1;
          const br = b.use_count > 0 ? b.win_count / b.use_count : -1;
          return br - ar;
        });
        setItems(sorted);
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
        ARSENAL
      </h1>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading assets…</div>
      ) : items.length === 0 ? (
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
              EMPTY ARSENAL
            </h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Talk to Forge. When patterns emerge, your assets land here
              automatically.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <div key={item.id} className="glass-card p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-display text-base text-foreground tracking-wide">
                  {item.title}
                </h3>
                <span className="text-[10px] font-display tracking-widest px-2 py-0.5 rounded-full border border-primary/30 text-primary bg-primary/5 shrink-0">
                  {item.type.toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                {item.content}
              </p>
              <div className="flex items-center justify-between pt-2 border-t border-border/30">
                {item.use_count > 0 ? (
                  <span className="text-xs text-accent flex items-center gap-1.5">
                    <Flame className="h-3.5 w-3.5" />
                    {item.win_count} of {item.use_count}{" "}
                    {item.use_count === 1 ? "close" : "closes"}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Awaiting first use
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {new Date(item.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ArsenalPage;

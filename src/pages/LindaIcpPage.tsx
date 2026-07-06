import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Target, Plus, Loader2, X } from "lucide-react";
import LindaNav from "@/components/LindaNav";

interface Icp {
  id: string;
  name: string;
  criteria: Record<string, string>;
  is_active: boolean;
  created_at: string;
}

const emptyForm = { name: "", industry: "", company_size: "", geography: "", budget_signal: "", must_have: "" };

export default function LindaIcpPage() {
  const { user } = useAuth();
  const [icps, setIcps] = useState<Icp[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const loadIcps = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("linda_icp")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setIcps(data ?? []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadIcps(); }, [loadIcps]);

  const toggleActive = async (icp: Icp) => {
    await supabase.from("linda_icp").update({ is_active: !icp.is_active }).eq("id", icp.id);
    setIcps(prev => prev.map(i => i.id === icp.id ? { ...i, is_active: !i.is_active } : i));
  };

  const createIcp = async () => {
    if (!user || !form.name.trim() || saving) return;
    setSaving(true);
    const criteria: Record<string, string> = {};
    if (form.industry.trim()) criteria.industry = form.industry.trim();
    if (form.company_size.trim()) criteria.company_size = form.company_size.trim();
    if (form.geography.trim()) criteria.geography = form.geography.trim();
    if (form.budget_signal.trim()) criteria.budget_signal = form.budget_signal.trim();
    if (form.must_have.trim()) criteria.must_have = form.must_have.trim();

    await supabase.from("linda_icp").insert({
      user_id: user.id,
      name: form.name.trim(),
      criteria,
      is_active: true,
    });
    setForm(emptyForm);
    setShowForm(false);
    setSaving(false);
    loadIcps();
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Ideal Customer Profiles</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Used to score prospect fit during intake · {icps.length} defined</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-teal-400 transition-all"
            style={{ background: "rgba(20,184,166,0.1)", border: "1px solid rgba(20,184,166,0.2)" }}>
            <Plus className="w-4 h-4" />
            New ICP
          </button>
          <a href="/linda" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400 transition-all"
             style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
            👁 Ask Linda
          </a>
        </div>
      </div>

      <div className="mb-6"><LindaNav /></div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="w-full max-w-lg rounded-2xl border border-border/30 p-5" style={{ background: "#111113" }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-zinc-200">New ICP</div>
              <button onClick={() => setShowForm(false)} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 mb-4">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Name (e.g. Marine Construction — Gulf Coast)"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
              <input value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}
                placeholder="Industry"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
              <input value={form.company_size} onChange={e => setForm(f => ({ ...f, company_size: e.target.value }))}
                placeholder="Company size (e.g. 10-50 employees)"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
              <input value={form.geography} onChange={e => setForm(f => ({ ...f, geography: e.target.value }))}
                placeholder="Geography"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
              <input value={form.budget_signal} onChange={e => setForm(f => ({ ...f, budget_signal: e.target.value }))}
                placeholder="Budget signal"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
              <input value={form.must_have} onChange={e => setForm(f => ({ ...f, must_have: e.target.value }))}
                placeholder="Must-have signal (one-line)"
                className="w-full rounded-lg px-3 py-2 text-xs bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/40" />
            </div>
            <button onClick={createIcp} disabled={saving || !form.name.trim()}
              className="w-full py-2 rounded-xl text-xs font-medium text-teal-400 flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
              style={{ background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.2)" }}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {saving ? "Saving…" : "Create ICP"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : icps.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 rounded-2xl border border-border/20 border-dashed">
          <Target className="w-8 h-8 text-zinc-700 mb-3" />
          <div className="text-sm text-zinc-500">No ICPs defined yet</div>
          <div className="text-xs text-zinc-700 mt-1">Prospect intake uses these to score fit — add one to get started</div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {icps.map(icp => (
            <div key={icp.id} className="rounded-2xl border border-border/30 p-4" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium text-zinc-200">{icp.name}</div>
                <button onClick={() => toggleActive(icp)}
                  className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-all"
                  style={icp.is_active
                    ? { background: "rgba(34,197,94,0.12)", color: "#86efac" }
                    : { background: "rgba(255,255,255,0.06)", color: "#71717a" }}>
                  {icp.is_active ? "Active" : "Inactive"}
                </button>
              </div>
              <div className="text-xs text-zinc-500 space-y-0.5">
                {Object.entries(icp.criteria ?? {}).map(([k, v]) => (
                  <div key={k}><span className="text-zinc-600 capitalize">{k.replace("_", " ")}:</span> {String(v)}</div>
                ))}
                {Object.keys(icp.criteria ?? {}).length === 0 && <div className="text-zinc-700">No criteria set</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

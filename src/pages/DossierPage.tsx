import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Download, Pencil, Check, X } from "lucide-react";
import { ObsidianVault } from "@/components/ObsidianVault";

const EDITABLE_FIELDS: { key: string; label: string; hint: string; section?: string }[] = [
  { key: "money_beliefs",            label: "Money Beliefs",            hint: "How you actually relate to money — observed, not stated" },
  { key: "risk_posture",             label: "Risk Posture",             hint: "conservative / aggressive / avoidant / calculated" },
  { key: "decision_pattern",         label: "Decision Pattern",         hint: "How you actually make decisions beneath the stated process" },
  { key: "follow_through_pattern",   label: "Follow-Through",           hint: "Do you execute on commitments? What does the pattern look like?" },
  { key: "avoidance_pattern",        label: "Avoidance Pattern",        hint: "What you reliably defer, avoid, or rationalize away" },
  { key: "current_phase",            label: "Current Phase",            hint: "growing / stabilizing / rebuilding / first hire / transition" },
  { key: "current_focus",            label: "Current Focus",            hint: "What is genuinely consuming your attention right now" },
  { key: "emotional_baseline",       label: "Emotional Baseline",       hint: "Your default register in conversation" },
  { key: "current_emotional_signal", label: "Current Emotional Signal", hint: "What you seem to be carrying right now" },
  { key: "last_heavy_exchange",      label: "Last Heavy Exchange",      hint: "If there was real emotional weight in a recent conversation" },
  { key: "preferred_asset_classes",  label: "Asset Classes",            hint: "forex / equity / crypto / options — what you actually want to trade", section: "Trading Profile" },
  { key: "risk_tolerance",           label: "Risk Tolerance",           hint: "conservative / moderate / aggressive — how much drawdown you can stomach" },
  { key: "trading_goals",            label: "Trading Goals",            hint: "What you're building with this operation — income, wealth, skill" },
  { key: "max_drawdown_pct",         label: "Max Drawdown",             hint: "The loss level that would make you stop — e.g. 20% of account" },
  { key: "preferred_pairs",          label: "Preferred Pairs",          hint: "Which symbols or pairs you actually want to trade" },
];

interface DossierRow { [key: string]: string | null }
interface EditingState { field: string; value: string }

type Tab = "profile" | "vault";

export default function DossierPage() {
  const { toast } = useToast();
  const [tab, setTab]           = useState<Tab>("profile");
  const [dossier, setDossier]   = useState<DossierRow>({});
  const [loading, setLoading]   = useState(true);
  const [editing, setEditing]   = useState<EditingState | null>(null);
  const [saving, setSaving]     = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { loadDossier(); }, []);

  async function loadDossier() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from("forge_dossier")
      .select(EDITABLE_FIELDS.map((f) => f.key).join(","))
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      toast({ title: "Error loading dossier", description: error.message, variant: "destructive" });
    } else {
      setDossier((data as unknown as DossierRow) ?? {});
    }
    setLoading(false);
  }

  function startEdit(field: string) {
    setEditing({ field, value: dossier[field] ?? "" });
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    const { error } = await supabase.rpc("correct_dossier_field", {
      _field_name: editing.field,
      _new_value:  editing.value.slice(0, 500),
    });
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    } else {
      setDossier((prev) => ({ ...prev, [editing.field]: editing.value.slice(0, 500) }));
      setEditing(null);
      toast({ title: "Saved", description: "Field updated and audit trail recorded." });
    }
    setSaving(false);
  }

  async function exportData() {
    setExporting(true);
    const { data, error } = await supabase.rpc("export_operator_data");
    if (error) {
      toast({ title: "Export failed", description: error.message, variant: "destructive" });
    } else {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `skyforge-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export ready", description: "Your data bundle has been downloaded." });
    }
    setExporting(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading your dossier…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-primary">Dossier</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            What Atlas knows about you — your profile and your knowledge vault.
          </p>
        </div>
        {tab === "profile" && (
          <Button variant="outline" size="sm" onClick={exportData} disabled={exporting}>
            <Download className="w-4 h-4 mr-1.5" />
            {exporting ? "Exporting…" : "Export My Data"}
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/30 shrink-0">
        {(["profile", "vault"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-primary"
            }`}
          >
            {t === "vault" ? "Knowledge Vault" : "Profile"}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {tab === "profile" && (
        <div className="max-w-2xl space-y-0 divide-y divide-border/40">
          {EDITABLE_FIELDS.map(({ key, label, hint, section }) => {
            const isEditing = editing?.field === key;
            const value     = dossier[key];
            return (
              <div key={key} className="py-4">
                {section && (
                  <p className="text-[10px] font-display tracking-widest text-accent uppercase mb-4 -mt-1">{section}</p>
                )}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {label}
                      </span>
                      {!isEditing && (
                        <button
                          onClick={() => startEdit(key)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                          aria-label={`Edit ${label}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {isEditing ? (
                      <div className="space-y-2">
                        <Textarea
                          value={editing.value}
                          onChange={(e) => setEditing({ field: key, value: e.target.value })}
                          className="text-sm resize-none min-h-[72px]"
                          maxLength={500}
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={saving}>
                            <Check className="w-3.5 h-3.5 mr-1" />
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                            <X className="w-3.5 h-3.5 mr-1" />
                            Cancel
                          </Button>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {editing.value.length}/500
                          </span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-primary">
                        {value ?? (
                          <span className="text-muted-foreground italic">{hint}</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground pt-4">
            Atlas builds this profile from your conversations. Corrections are recorded with source "user_correction".
          </p>
        </div>
      )}

      {/* Vault tab */}
      {tab === "vault" && (
        <div className="flex-1 min-h-0" style={{ height: "calc(100vh - 200px)" }}>
          <ObsidianVault />
        </div>
      )}
    </div>
  );
}

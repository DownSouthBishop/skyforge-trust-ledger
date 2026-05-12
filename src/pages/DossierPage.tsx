import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Download, Pencil, Check, X } from "lucide-react";

const EDITABLE_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "money_beliefs",            label: "Money Beliefs",         hint: "How you actually relate to money — observed, not stated" },
  { key: "risk_posture",             label: "Risk Posture",          hint: "conservative / aggressive / avoidant / calculated" },
  { key: "decision_pattern",         label: "Decision Pattern",      hint: "How you actually make decisions beneath the stated process" },
  { key: "follow_through_pattern",   label: "Follow-Through",        hint: "Do you execute on commitments? What does the pattern look like?" },
  { key: "avoidance_pattern",        label: "Avoidance Pattern",     hint: "What you reliably defer, avoid, or rationalize away" },
  { key: "current_phase",            label: "Current Phase",         hint: "growing / stabilizing / rebuilding / first hire / transition" },
  { key: "current_focus",            label: "Current Focus",         hint: "What is genuinely consuming your attention right now" },
  { key: "emotional_baseline",       label: "Emotional Baseline",    hint: "Your default register in conversation" },
  { key: "current_emotional_signal", label: "Current Emotional Signal", hint: "What you seem to be carrying right now" },
  { key: "last_heavy_exchange",      label: "Last Heavy Exchange",   hint: "If there was real emotional weight in a recent conversation" },
];

interface DossierRow {
  [key: string]: string | null;
}

interface EditingState {
  field: string;
  value: string;
}

export default function DossierPage() {
  const { toast } = useToast();
  const [dossier, setDossier] = useState<DossierRow>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    loadDossier();
  }, []);

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
      setDossier((data as DossierRow) ?? {});
    }
    setLoading(false);
  }

  function startEdit(field: string) {
    setEditing({ field, value: dossier[field] ?? "" });
  }

  function cancelEdit() {
    setEditing(null);
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
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-primary">Your Dossier</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            What Atlas knows about you. Correct anything that's wrong — every change is logged.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportData} disabled={exporting}>
          <Download className="w-4 h-4 mr-1.5" />
          {exporting ? "Exporting…" : "Export My Data"}
        </Button>
      </div>

      <div className="divide-y divide-border/40">
        {EDITABLE_FIELDS.map(({ key, label, hint }) => {
          const isEditing = editing?.field === key;
          const value     = dossier[key];

          return (
            <div key={key} className="py-4">
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
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
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
      </div>

      <p className="text-xs text-muted-foreground border-t border-border/30 pt-4">
        Atlas builds this profile from your conversations. Corrections are recorded with source "user_correction" and override extracted values. Export includes your dossier, goals, pipeline, commitments, and last 500 receipts.
      </p>
    </div>
  );
}

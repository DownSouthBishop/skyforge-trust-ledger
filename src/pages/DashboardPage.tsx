import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Check, Flame, Phone } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

interface Receipt {
  id: string;
  description: string;
  value: number;
  status: "PENDING" | "VERIFIED" | "DISPUTED";
  created_at: string;
  client_name: string;
}

const DashboardPage = () => {
  const { user } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [step, setStep] = useState(1);
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [clientName, setClientName] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([
    { id: "1", description: "Roof leak repair - residential", value: 1200, status: "VERIFIED", created_at: new Date().toISOString(), client_name: "John D." },
    { id: "2", description: "Full HVAC system maintenance", value: 3500, status: "PENDING", created_at: new Date().toISOString(), client_name: "Sarah M." },
    { id: "3", description: "Emergency pipe fix", value: 450, status: "VERIFIED", created_at: new Date().toISOString(), client_name: "Mike R." },
  ]);

  const trustScore = 87;
  const fireStreak = 12;
  const verifiedCount = receipts.filter((r) => r.status === "VERIFIED").length;

  const handleIssue = () => {
    if (step < 3) {
      setStep(step + 1);
      return;
    }
    const newReceipt: Receipt = {
      id: Date.now().toString(),
      description,
      value: parseFloat(value),
      status: "PENDING",
      created_at: new Date().toISOString(),
      client_name: clientName,
    };
    setReceipts([newReceipt, ...receipts]);
    setShowModal(false);
    setStep(1);
    setDescription("");
    setValue("");
    setClientName("");
    toast.success("Receipt issued! Verification link generated.");
  };

  const handleRespondFall = () => {
    const fallReceipt: Receipt = {
      id: Date.now().toString(),
      description: "Missed call intercepted — follow-up required",
      value: 0,
      status: "PENDING",
      created_at: new Date().toISOString(),
      client_name: "Unknown Caller",
    };
    setReceipts([fallReceipt, ...receipts]);
    toast.info("RespondFall: Missed call intercepted. PENDING receipt created.");
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header with Eagle accent */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
            COMMAND CENTER
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Operator: {user?.user_metadata?.full_name || user?.email}
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleRespondFall}
            variant="outline"
            className="border-primary/30 text-primary hover:bg-primary/10 gap-2"
          >
            <Phone className="h-4 w-4" />
            <span className="hidden sm:inline">RespondFall</span>
          </Button>
          <Button
            onClick={() => setShowModal(true)}
            className="bg-accent text-accent-foreground hover:bg-accent/90 glow-orange font-display tracking-wider gap-2"
          >
            <Plus className="h-4 w-4" />
            Issue Receipt
          </Button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Trust Score Radial */}
        <div className="glass-card p-5 flex flex-col items-center justify-center col-span-2 md:col-span-1">
          <div className="relative w-24 h-24">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="hsl(220,30%,16%)" strokeWidth="8" />
              <circle
                cx="50" cy="50" r="42" fill="none"
                stroke="hsl(217,91%,60%)" strokeWidth="8"
                strokeDasharray={`${trustScore * 2.64} 264`}
                strokeLinecap="round"
                className="drop-shadow-[0_0_8px_hsla(217,91%,60%,0.5)]"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-2xl font-display text-primary">{trustScore}</span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground mt-2">Trust Score</span>
        </div>

        <div className="glass-card p-5 flex flex-col items-center justify-center">
          <div className="text-3xl mb-1">🔥</div>
          <div className="text-2xl font-display text-accent">{fireStreak}</div>
          <span className="text-xs text-muted-foreground">Fire Streak</span>
        </div>

        <div className="glass-card p-5 flex flex-col items-center justify-center">
          <div className="text-2xl font-display text-primary">{verifiedCount}</div>
          <span className="text-xs text-muted-foreground">Verified</span>
        </div>

        <div className="glass-card p-5 flex flex-col items-center justify-center">
          <div className="text-2xl font-display text-accent">
            ${receipts.reduce((s, r) => s + r.value, 0).toLocaleString()}
          </div>
          <span className="text-xs text-muted-foreground">Total Volume</span>
        </div>
      </div>

      {/* Action History */}
      <div className="glass-card p-5">
        <h2 className="text-sm font-display tracking-widest text-primary mb-4 uppercase">
          Action History
        </h2>
        <div className="space-y-3">
          {receipts.map((r) => (
            <div key={r.id} className="flex items-center gap-4 p-3 rounded-lg bg-secondary/20 border border-border/20">
              <div className={`h-2 w-2 rounded-full shrink-0 ${
                r.status === "VERIFIED" ? "bg-green-500" :
                r.status === "DISPUTED" ? "bg-destructive" : "bg-accent animate-pulse-glow"
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{r.description}</div>
                <div className="text-xs text-muted-foreground">
                  {r.client_name} · {r.status}
                </div>
              </div>
              <div className="text-sm font-display text-primary shrink-0">
                {r.value > 0 ? `$${r.value.toLocaleString()}` : "—"}
              </div>
              {r.status === "VERIFIED" && (
                <img src={skyforgeEagle} alt="Verified" className="w-6 h-6 rounded-full object-cover opacity-60" loading="lazy" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Issue Receipt Modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="glass-card-strong border-border/30 max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-wider text-primary text-glow-blue">
              {step === 1 && "Define Action"}
              {step === 2 && "Set Value"}
              {step === 3 && "Send to Client"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {step === 1 && (
              <Textarea
                placeholder="Describe the completed action..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="bg-secondary/30 border-border/30 min-h-[100px]"
              />
            )}
            {step === 2 && (
              <Input
                type="number"
                placeholder="Value in USD"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="bg-secondary/30 border-border/30"
              />
            )}
            {step === 3 && (
              <Input
                placeholder="Client name or email"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className="bg-secondary/30 border-border/30"
              />
            )}
            <div className="flex justify-between items-center">
              <div className="flex gap-1">
                {[1, 2, 3].map((s) => (
                  <div key={s} className={`h-1.5 w-8 rounded-full ${s <= step ? "bg-accent" : "bg-border"}`} />
                ))}
              </div>
              <Button
                onClick={handleIssue}
                className="bg-accent text-accent-foreground hover:bg-accent/90 font-display tracking-wider"
              >
                {step < 3 ? "Next" : "Issue & Generate Link"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DashboardPage;

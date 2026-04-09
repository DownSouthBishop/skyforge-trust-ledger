import { useAuth } from "@/contexts/AuthContext";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";
import skyforgeSeal from "@/assets/skyforge-seal.png";

const ProfilePage = () => {
  const { user } = useAuth();
  const name = user?.user_metadata?.full_name || "Operator";

  const verifiedProofs = [
    { desc: "Roof leak repair - residential", value: 1200, date: "2026-04-08" },
    { desc: "Full HVAC system maintenance", value: 3500, date: "2026-04-06" },
    { desc: "Emergency pipe fix", value: 450, date: "2026-04-03" },
    { desc: "Electrical panel upgrade", value: 2800, date: "2026-03-29" },
  ];

  const totalVolume = verifiedProofs.reduce((s, p) => s + p.value, 0);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      {/* Sovereign Card */}
      <div className="glass-card relative overflow-hidden">
        <div className="absolute inset-0">
          <img src={skyforgeEagle} alt="" className="w-full h-full object-cover opacity-20" loading="lazy" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/90 to-background/70" />
        </div>
        <div className="relative p-6 md:p-10 flex flex-col md:flex-row items-start md:items-center gap-6">
          <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-primary/30 glow-blue shrink-0">
            <img src={skyforgeEagle} alt={name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
              {name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{user?.email}</p>
            <p className="text-xs text-muted-foreground/60 mt-1 font-mono">
              ID: {user?.id?.slice(0, 12)}...
            </p>
          </div>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-2xl font-display text-accent">{verifiedProofs.length}</div>
              <div className="text-xs text-muted-foreground">Verified Actions</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-display text-primary">${totalVolume.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Volume Managed</div>
            </div>
          </div>
        </div>
      </div>

      {/* Verified Proofs List */}
      <div className="glass-card p-5">
        <h2 className="text-sm font-display tracking-widest text-primary mb-4 uppercase">
          Verified Proofs
        </h2>
        <div className="space-y-3">
          {verifiedProofs.map((proof, i) => (
            <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-secondary/20 border border-border/20">
              <img src={skyforgeSeal} alt="Seal" className="w-8 h-8 opacity-70" loading="lazy" />
              <div className="flex-1 min-w-0">
                <div className="text-sm">{proof.desc}</div>
                <div className="text-xs text-muted-foreground">{proof.date}</div>
              </div>
              <div className="text-sm font-display text-accent">${proof.value.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;

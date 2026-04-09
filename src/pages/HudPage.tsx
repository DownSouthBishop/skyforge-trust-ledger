import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

const mockFeed = [
  "Miami Roofing verified a leak repair for $1,200",
  "Apex Electric confirmed panel install for $3,500",
  "CleanPro Services verified deep clean for $450",
  "Nova Plumbing confirmed pipe replacement for $890",
  "Summit HVAC verified AC unit install for $2,800",
  "Precision Auto verified brake service for $320",
];

const HudPage = () => {
  const [search, setSearch] = useState("");
  const [feedIndex, setFeedIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFeedIndex((i) => (i + 1) % mockFeed.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-6xl mx-auto">
      {/* Hero */}
      <div className="relative rounded-2xl overflow-hidden h-64 md:h-80">
        <img
          src={skyforgeEagle}
          alt="Skyforge Protocol"
          className="absolute inset-0 w-full h-full object-cover"
          width={1920}
          height={1080}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-6 md:p-10">
          <h1 className="text-2xl md:text-4xl font-display tracking-wider text-primary text-glow-blue mb-2">
            GLOBAL HUD
          </h1>
          <p className="text-sm text-muted-foreground max-w-lg">
            The Sovereign Ledger — every verified action, transparent and immutable.
          </p>
        </div>
      </div>

      {/* Universal Trust Search */}
      <div className="glass-card p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary/50" />
          <Input
            placeholder="Search any user or business by name or Skyforge ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-secondary/30 border-border/30 placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      {/* Live Verified Proofs Ticker */}
      <div className="glass-card p-4 overflow-hidden">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-2 w-2 rounded-full bg-accent animate-pulse-glow" />
          <span className="text-xs font-display tracking-widest text-accent uppercase">
            Live Verified Proofs
          </span>
        </div>
        <div className="relative h-8 overflow-hidden">
          {mockFeed.map((item, i) => (
            <div
              key={i}
              className={`absolute inset-0 flex items-center transition-all duration-500 ${
                i === feedIndex
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-4"
              }`}
            >
              <span className="text-sm text-foreground/80">
                ✅ <span className="text-primary">{item.split(" verified ")[0] || item.split(" confirmed ")[0]}</span>
                {" "}{item.includes("verified") ? "verified" : "confirmed"} {item.split(/verified |confirmed /)[1]}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Verified", value: "12,847", color: "text-primary" },
          { label: "Active Operators", value: "1,293", color: "text-accent" },
          { label: "Volume (USD)", value: "$4.2M", color: "text-primary" },
          { label: "Trust Score Avg", value: "87.3", color: "text-accent" },
        ].map((stat) => (
          <div key={stat.label} className="glass-card p-4 text-center space-y-1">
            <div className={`text-2xl font-display ${stat.color}`}>{stat.value}</div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default HudPage;

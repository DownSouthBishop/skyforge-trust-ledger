const IntelPage = () => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const values = [1200, 3200, 2800, 4500, 3800, 5200];
  const maxVal = Math.max(...values);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto">
      <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
        INTEL CENTER
      </h1>

      {/* Performance Chart */}
      <div className="glass-card p-6">
        <h2 className="text-sm font-display tracking-widest text-primary mb-6 uppercase">
          Monthly Revenue
        </h2>
        <div className="flex items-end gap-3 h-48">
          {months.map((m, i) => (
            <div key={m} className="flex-1 flex flex-col items-center gap-2">
              <span className="text-xs font-display text-primary">
                ${(values[i] / 1000).toFixed(1)}k
              </span>
              <div
                className="w-full rounded-t-md bg-gradient-to-t from-accent/80 to-primary/80 transition-all"
                style={{ height: `${(values[i] / maxVal) * 100}%` }}
              />
              <span className="text-xs text-muted-foreground">{m}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-5">
          <h3 className="text-xs font-display tracking-widest text-muted-foreground mb-2">COMPLETION RATE</h3>
          <div className="text-3xl font-display text-primary">94.7%</div>
          <div className="h-2 rounded-full bg-secondary mt-3 overflow-hidden">
            <div className="h-full w-[94.7%] rounded-full bg-gradient-to-r from-primary to-accent" />
          </div>
        </div>
        <div className="glass-card p-5">
          <h3 className="text-xs font-display tracking-widest text-muted-foreground mb-2">DISPUTE RATE</h3>
          <div className="text-3xl font-display text-accent">2.1%</div>
          <div className="h-2 rounded-full bg-secondary mt-3 overflow-hidden">
            <div className="h-full w-[2.1%] rounded-full bg-accent" />
          </div>
        </div>
        <div className="glass-card p-5">
          <h3 className="text-xs font-display tracking-widest text-muted-foreground mb-2">AVG RESPONSE TIME</h3>
          <div className="text-3xl font-display text-primary">1.4h</div>
          <p className="text-xs text-muted-foreground mt-2">Top 15% of operators</p>
        </div>
      </div>

      {/* Verification Heatmap */}
      <div className="glass-card p-5">
        <h2 className="text-sm font-display tracking-widest text-primary mb-4 uppercase">
          Verification Activity (7d)
        </h2>
        <div className="grid grid-cols-7 gap-2">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="text-center">
              <span className="text-[10px] text-muted-foreground">{d}</span>
              <div
                className="h-8 mt-1 rounded-md"
                style={{
                  backgroundColor: `hsla(217, 91%, 60%, ${0.15 + Math.random() * 0.6})`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default IntelPage;

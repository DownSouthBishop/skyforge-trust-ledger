import { Shield } from "lucide-react";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

const ArsenalPage = () => (
  <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
    <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
      ARSENAL
    </h1>

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
          COMING SOON
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          The Arsenal will house your digital assets, tools, and integrations.
          Stay tuned for the next protocol update.
        </p>
      </div>
    </div>
  </div>
);

export default ArsenalPage;

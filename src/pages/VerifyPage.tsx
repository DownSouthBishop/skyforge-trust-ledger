import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import confetti from "canvas-confetti";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";
import skyforgeSeal from "@/assets/skyforge-seal.png";
import StarField from "@/components/StarField";

const VerifyPage = () => {
  const [params] = useSearchParams();
  const [verified, setVerified] = useState(false);

  const provider = params.get("provider") || "Skyforge Provider";
  const action = params.get("action") || "a completed service";
  const value = params.get("value") || "0";

  const handleApprove = () => {
    setVerified(true);
    confetti({
      particleCount: 150,
      spread: 80,
      origin: { y: 0.6 },
      colors: ["#3b82f6", "#f97316", "#ffffff"],
    });
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <img src={skyforgeEagle} alt="" className="absolute inset-0 w-full h-full object-cover opacity-20" />
      <div className="absolute inset-0 bg-background/70" />
      <StarField />

      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="glass-card-strong p-8 space-y-6 text-center">
          <img src={skyforgeSeal} alt="Skyforge Seal" className="w-16 h-16 mx-auto" />

          {!verified ? (
            <>
              <h1 className="text-lg font-display tracking-wider text-primary text-glow-blue">
                VERIFICATION REQUEST
              </h1>
              <p className="text-foreground/80">
                Verify <span className="text-accent font-semibold">{provider}</span> completed:
              </p>
              <div className="glass-card p-4">
                <p className="text-sm text-foreground">{action}</p>
                {parseFloat(value) > 0 && (
                  <p className="text-lg font-display text-accent mt-2">${parseFloat(value).toLocaleString()}</p>
                )}
              </div>
              <Button
                onClick={handleApprove}
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90 glow-orange font-display tracking-wider gap-2"
              >
                <Check className="h-4 w-4" />
                Approve & Sign
              </Button>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
                <Check className="h-8 w-8 text-green-400" />
              </div>
              <h1 className="text-lg font-display tracking-wider text-green-400">
                VERIFIED
              </h1>
              <p className="text-sm text-muted-foreground">
                This action has been verified and sealed on the Skyforge ledger.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default VerifyPage;

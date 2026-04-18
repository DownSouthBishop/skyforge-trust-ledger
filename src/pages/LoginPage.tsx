import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import StarField from "@/components/StarField";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";
import { lovable } from "@/integrations/lovable";

const LoginPage = () => {
  const { signIn, signUp } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isSignUp) {
        await signUp(email, password, fullName);
        toast.success("Account created! Check your email to verify.");
      } else {
        await signIn(email, password);
        toast.success("Welcome back, Operator.");
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Full-screen Eagle background */}
      <img
        src={skyforgeEagle}
        alt="Skyforge Eagle"
        className="absolute inset-0 w-full h-full object-cover"
        width={1920}
        height={1080}
      />
      {/* Overlay for readability */}
      <div className="absolute inset-0 bg-background/60" />
      <div className="absolute inset-0 horizon-glow" />
      <StarField />

      {/* Login Card */}
      <div className="relative z-10 w-full max-w-md mx-4 animate-slide-up">
        <div className="glass-card-strong p-8 space-y-6">
          {/* Logo */}
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-display tracking-wider text-primary text-glow-blue">
              SKYFORGE
            </h1>
            <p className="text-sm text-muted-foreground">
              The Universal Ledger of Human Action.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <Input
                placeholder="Full Name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="bg-secondary/50 border-border/50 placeholder:text-muted-foreground/50"
              />
            )}
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-secondary/50 border-border/50 placeholder:text-muted-foreground/50"
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-secondary/50 border-border/50 placeholder:text-muted-foreground/50"
            />
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-accent text-accent-foreground hover:bg-accent/90 glow-orange font-display tracking-wider"
            >
              {loading ? "Authenticating..." : isSignUp ? "CREATE IDENTITY" : "ENTER PROTOCOL"}
            </Button>
          </form>

          <div className="text-center">
            <button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-sm text-primary hover:text-primary/80 transition-colors"
            >
              {isSignUp ? "Already have an identity? Sign in" : "New operator? Create identity"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

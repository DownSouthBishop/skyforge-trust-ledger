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

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast.error(result.error.message ?? "Google sign-in failed");
        setLoading(false);
        return;
      }
      if (result.redirected) return;
      toast.success("Welcome, Operator.");
    } catch (err: any) {
      toast.error(err?.message ?? "Google sign-in failed");
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <img
        src={skyforgeEagle}
        alt="Skyforge Eagle"
        className="absolute inset-0 w-full h-full object-cover"
        width={1920}
        height={1080}
      />
      <div className="absolute inset-0 bg-background/60" />
      <div className="absolute inset-0 horizon-glow" />
      <StarField />

      <div className="relative z-10 w-full max-w-md mx-4 animate-slide-up">
        <div className="glass-card-strong p-8 space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-display tracking-wider text-primary text-glow-blue">
              SKYFORGE
            </h1>
            <p className="text-sm text-muted-foreground">
              The Universal Ledger of Human Action.
            </p>
          </div>

          <Button
            type="button"
            onClick={handleGoogle}
            disabled={loading}
            variant="outline"
            className="w-full bg-secondary/40 border-border/60 hover:bg-secondary/70 text-foreground font-display tracking-wider"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.46c-.28 1.48-1.13 2.74-2.41 3.58v2.97h3.9c2.28-2.1 3.59-5.2 3.59-8.79z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.9-2.97c-1.08.72-2.45 1.16-4.04 1.16-3.11 0-5.74-2.1-6.68-4.93H1.3v3.09C3.28 21.31 7.31 24 12 24z" />
              <path fill="#FBBC05" d="M5.32 14.35a7.2 7.2 0 010-4.7V6.56H1.3a12 12 0 000 10.88l4.02-3.09z" />
              <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.28 2.69 1.3 6.56l4.02 3.09C6.26 6.87 8.89 4.77 12 4.77z" />
            </svg>
            CONTINUE WITH GOOGLE
          </Button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border/50" />
            <span className="text-[10px] tracking-widest font-display text-muted-foreground">
              OR EMAIL
            </span>
            <div className="h-px flex-1 bg-border/50" />
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

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import type { User, Session } from "@supabase/supabase-js";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
};

const OWNER_EMAIL    = import.meta.env.VITE_OWNER_EMAIL as string | undefined;
const OWNER_PASSWORD = import.meta.env.VITE_OWNER_PASSWORD as string | undefined;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // onAuthStateChange handles sign-in, sign-out, and token refresh.
    // We never flip loading back to true here — that would unmount the whole
    // app on every token refresh (every ~hour) and cause a visible hard reset.
    // We also skip nulling the user on SIGNED_OUT unless it's intentional
    // (handled by the explicit_signout flag + signOut() method).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        setSession(null);
        setUser(null);
      } else if (session) {
        setSession(session);
        // Stable reference: only swap the user object when the actual user ID changes.
        // TOKEN_REFRESHED fires every ~hour with a new session object but the same user —
        // keeping the same reference prevents every [user] useCallback/useEffect from re-firing.
        setUser(prev => (prev?.id === session.user?.id ? prev : session.user));
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSession(session);
        setUser(session.user);
        setLoading(false);
      } else if (OWNER_EMAIL && OWNER_PASSWORD) {
        // No login wall on this app — always establish the operator session
        // silently so RLS-backed queries and edge functions keep working.
        supabase.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
          .then(({ data }) => {
            setSession(data.session);
            setUser(data.session?.user ?? null);
          })
          .catch(() => {})
          .finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, fullName: string) => {
    localStorage.removeItem("explicit_signout");
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw error;
  };

  const signIn = async (email: string, password: string) => {
    localStorage.removeItem("explicit_signout");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    localStorage.setItem("explicit_signout", "1");
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

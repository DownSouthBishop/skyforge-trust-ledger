import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;

export type SubscriberTier = "FREE" | "SIGNAL" | "COPYTRADE" | "INSTITUTIONAL";

export interface Subscriber {
  id: string;
  email: string;
  tier: SubscriberTier;
  monthly_amount: number;
  status: string;
  subscribed_at: string;
  last_billed?: string;
}

export const TIER_PRICES = {
  FREE: 0,
  SIGNAL: 97,
  COPYTRADE: 197,
  INSTITUTIONAL: 497,
} as const;

export async function getSubscriber(email: string): Promise<Subscriber | null> {
  const { data, error } = await supabase
    .from("atlas_subscribers")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("[atlas-stripe] getSubscriber error:", error);
    return null;
  }

  return data as Subscriber | null;
}

export async function getSubscriberCounts(): Promise<Record<SubscriberTier, number>> {
  const counts: Record<SubscriberTier, number> = {
    FREE: 0,
    SIGNAL: 0,
    COPYTRADE: 0,
    INSTITUTIONAL: 0,
  };

  const { data, error } = await supabase
    .from("atlas_subscribers")
    .select("tier");

  if (error) {
    console.error("[atlas-stripe] getSubscriberCounts error:", error);
    return counts;
  }

  for (const row of data ?? []) {
    const tier = row.tier as SubscriberTier;
    if (tier in counts) {
      counts[tier] += 1;
    }
  }

  return counts;
}

export async function getMonthlyRevenue(): Promise<number> {
  const { data, error } = await supabase
    .from("atlas_subscribers")
    .select("monthly_amount")
    .eq("status", "active");

  if (error) {
    console.error("[atlas-stripe] getMonthlyRevenue error:", error);
    return 0;
  }

  return (data ?? []).reduce((sum, row) => sum + (row.monthly_amount ?? 0), 0);
}

export function getCheckoutUrl(tier: SubscriberTier): string {
  const baseUrl = "https://checkout.stripe.com/pay/";

  switch (tier) {
    case "SIGNAL":
      return `${baseUrl}${import.meta.env.VITE_STRIPE_SIGNAL_PRICE_ID ?? ""}`;
    case "INSTITUTIONAL":
      return `${baseUrl}${import.meta.env.VITE_STRIPE_INSTITUTIONAL_PRICE_ID ?? ""}`;
    case "COPYTRADE":
      return `${baseUrl}${import.meta.env.VITE_STRIPE_COPYTRADE_PRICE_ID ?? ""}`;
    case "FREE":
    default:
      return "/signup";
  }
}

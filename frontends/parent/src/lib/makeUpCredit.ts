import { useEffect, useState } from "react";
import { supabase } from "./supabase";

/**
 * Make-up credit (migration 00276): a parent's make-up tokens with one vendor are a money balance.
 * One row per vendor, so a parent with credit at two vendors sees two balances, never one.
 */
export interface VendorCredit {
  providerId: string;
  name: string;
  logoUrl: string | null;
  cents: number;
  /** Soonest expiry among the lots that make up the balance (null = none of them expires). */
  nextExpiry: string | null;
}

/** The parent's spendable balances, keyed by vendor. Empty until loaded, and when logged out. */
export function useMakeUpCredit(userId: string | undefined): {
  list: VendorCredit[];
  byProvider: Record<string, VendorCredit>;
  loaded: boolean;
} {
  const [list, setList] = useState<VendorCredit[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!userId) {
      setList([]);
      setLoaded(true);
      return;
    }
    let live = true;
    (async () => {
      const { data, error } = await supabase.rpc("my_make_up_credit");
      if (!live) return;
      if (error) {
        console.error("make-up credit", error.message);
        setList([]);
      } else {
        const rows = (data ?? []) as Array<{ provider_id: string; business_name: string; logo_url: string | null; balance_cents: number; next_expiry: string | null }>;
        setList(
          rows
            .filter((r) => r.balance_cents > 0)
            .map((r) => ({ providerId: r.provider_id, name: r.business_name, logoUrl: r.logo_url, cents: r.balance_cents, nextExpiry: r.next_expiry }))
        );
      }
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [userId]);
  return { list, byProvider: Object.fromEntries(list.map((c) => [c.providerId, c])), loaded };
}

/** How much of `baseCents` a balance pays. Mirrors the server: never leaves the card under 50c. */
export function creditToApply(baseCents: number, balanceCents: number): number {
  if (baseCents <= 0 || balanceCents <= 0) return 0;
  let apply = Math.min(baseCents, balanceCents);
  if (baseCents - apply > 0 && baseCents - apply < 50) apply = Math.max(baseCents - 50, 0);
  return apply;
}

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

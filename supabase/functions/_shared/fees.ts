// TaskLeaders — Category Fee Lookup
//
// DB-first fee resolution with constant fallback.
// This abstraction exists specifically to enable clean migration from
// hardcoded constants to admin-managed DB pricing without refactoring
// any of the calling edge functions.
//
// Upgrade path (zero code changes required in callers):
//   Phase 2 (now): DB table is seeded with locked values. DB row takes
//                  precedence. If row missing or inactive, falls back to
//                  CATEGORY_LEAD_FEES_CENTS in constants.ts.
//   Future phase:  Admin Panel writes to category_fee_config. Code below
//                  already uses those values. Remove constants.ts fallback
//                  once DB is authoritative.
//
// Always stores base_fee + gst + total separately (locked rule).

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CATEGORY_LEAD_FEES_CENTS, GST_RATE } from "./constants.ts";

export interface FeeBreakdown {
  baseFee: number;   // in cents
  gst:     number;   // in cents, rounded
  total:   number;   // in cents
}

/**
 * Resolves the lead fee for a category code.
 * Checks category_fee_config DB table first (is_active = true).
 * Falls back to CATEGORY_LEAD_FEES_CENTS constants if no DB row found.
 * Returns null if category is unknown in both sources.
 */
export async function getCategoryLeadFee(
  supabase: SupabaseClient,
  categoryCode: string,
): Promise<FeeBreakdown | null> {
  // DB-first: check category_fee_config
  const { data } = await supabase
    .from("category_fee_config")
    .select("lead_fee_cents")
    .eq("category_code", categoryCode)
    .eq("is_active", true)
    .maybeSingle();

  const baseFee = data?.lead_fee_cents ?? CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? null;
  if (!baseFee) return null;

  const gst   = Math.round(baseFee * GST_RATE);
  const total = baseFee + gst;
  return { baseFee, gst, total };
}

/**
 * Synchronous fallback — returns breakdown from constants only.
 * Use when a Supabase client is not available (e.g. validation logic).
 */
export function getCategoryLeadFeeSync(categoryCode: string): FeeBreakdown | null {
  const base = CATEGORY_LEAD_FEES_CENTS[categoryCode] ?? null;
  if (!base) return null;
  const gst = Math.round(base * GST_RATE);
  return { baseFee: base, gst, total: base + gst };
}

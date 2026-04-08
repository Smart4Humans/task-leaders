// TaskLeaders — Shared Constants
// All locked business rules live here. Do not inline these values elsewhere.

// ─── Category codes and display names ───────────────────────────────────────
export const CATEGORY_NAMES: Record<string, string> = {
  PLM: "Plumbing",
  CLN: "Cleaning",
  HND: "Handyman",
  ELC: "Electrical",
  PLT: "Painting",
  HVC: "HVAC",
  MVG: "Moving / Transport",
  YRD: "Yard Work",
};

// Slug (from provider_accounts.primary_service) → category code
export const SLUG_TO_CATEGORY_CODE: Record<string, string> = {
  "plumbing":    "PLM",
  "cleaning":    "CLN",
  "handyman":    "HND",
  "electrical":  "ELC",
  "painting":    "PLT",
  "hvac":        "HVC",
  "moving":      "MVG",
  "yard-work":   "YRD",
};

export const CATEGORY_CODE_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_CATEGORY_CODE).map(([slug, code]) => [code, slug]),
);

// ─── Lead fees — flat by category (locked) ──────────────────────────────────
// Stored in cents. GST (5%) calculated separately on top.
// Source: TaskLeaders Guidelines, locked 2026-04-08.
export const CATEGORY_LEAD_FEES_CENTS: Record<string, number> = {
  CLN: 1500,   // $15.00
  YRD: 1500,   // $15.00
  HND: 2000,   // $20.00
  MVG: 2500,   // $25.00
  PLT: 4000,   // $40.00
  PLM: 5000,   // $50.00
  ELC: 5000,   // $50.00
  HVC: 6000,   // $60.00
};

// GST rate (Canada)
export const GST_RATE = 0.05;

/** Calculate GST on a base fee in cents. Rounds to nearest cent. */
export function calcGst(baseFeeCents: number): number {
  return Math.round(baseFeeCents * GST_RATE);
}

/** Returns { baseFee, gst, total } in cents for a given category code. */
export function getLeadFeeBreakdown(categoryCode: string): {
  baseFee: number;
  gst: number;
  total: number;
} | null {
  const base = CATEGORY_LEAD_FEES_CENTS[categoryCode];
  if (!base) return null;
  const gst = calcGst(base);
  return { baseFee: base, gst, total: base + gst };
}

// ─── Payment timing (locked) ────────────────────────────────────────────────
// Window: 10 minutes total. Warning fires at 5 minutes remaining.
// WT-6 says "5 minutes left" — this is correct; it refers to the warning threshold.
// Do NOT use these to mean "5-minute window" — that older rule is superseded.
export const PAYMENT_WINDOW_MS      = 10 * 60 * 1000;  // 10 minutes
export const PAYMENT_WARNING_OFFSET_MS = 5 * 60 * 1000; // warn at: timeout_at - 5min

// ─── City codes ─────────────────────────────────────────────────────────────
export const VALID_CITY_CODES = new Set(["VAN", "VIC", "YYC", "YEG", "YYZ", "MTL"]);
export const VALID_CATEGORY_CODES = new Set(Object.keys(CATEGORY_NAMES));

// Maps city code → names/aliases used in service_cities TEXT[] on provider_accounts
export const CITY_CODE_TO_NAMES: Record<string, string[]> = {
  VAN: ["Vancouver", "van", "vancouver", "Metro Vancouver", "Metro Van"],
  VIC: ["Victoria", "vic", "victoria"],
  YYC: ["Calgary", "yyc", "calgary"],
  YEG: ["Edmonton", "yeg", "edmonton"],
  YYZ: ["Toronto", "yyz", "toronto", "GTA"],
  MTL: ["Montreal", "mtl", "montreal", "Montréal"],
};

/** Returns true if a provider's service_cities array covers the given city code. */
export function providerCoversCity(
  serviceCities: string[] | null | undefined,
  cityCode: string,
): boolean {
  if (!serviceCities || serviceCities.length === 0) return false;
  const aliases = CITY_CODE_TO_NAMES[cityCode] ?? [];
  return serviceCities.some((c) =>
    aliases.some((a) => c.toLowerCase() === a.toLowerCase()),
  );
}

// ─── Inbound keyword constants ───────────────────────────────────────────────
// Canonical responses from providers and clients.
export const KW_ACCEPT      = "ACCEPT";
export const KW_PASS        = "PASS";
export const KW_DECLINE     = "DECLINE";
export const KW_HELP        = "HELP";
export const KW_KEEP_OPEN   = "KEEP OPEN";
export const KW_CANCEL      = "CANCEL";
export const KW_YES         = "YES";
export const KW_NO          = "NO";

/** Normalizes inbound message body for keyword matching. */
export function normalizeKeyword(body: string): string {
  return body.trim().toUpperCase().replace(/[^A-Z ]/g, "");
}

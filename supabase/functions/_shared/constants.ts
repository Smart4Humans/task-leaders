// TaskLeaders — Shared Constants
// All locked business rules live here. Do not inline these values elsewhere.
// For lead fee resolution with DB override, use _shared/fees.ts instead of
// CATEGORY_LEAD_FEES_CENTS directly.

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
// Stored in cents. GST (5%) calculated separately at runtime.
// These are fallback constants. Authoritative source is category_fee_config table.
// See _shared/fees.ts for DB-first resolution.
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

export const GST_RATE = 0.05;

// ─── Payment timing (locked) ────────────────────────────────────────────────
export const PAYMENT_WINDOW_MS         = 10 * 60 * 1000; // 10 minutes total
export const PAYMENT_WARNING_OFFSET_MS =  5 * 60 * 1000; // warn at: timeout_at - 5 min

// ─── Marketplace timing ──────────────────────────────────────────────────────
// How long a targeted Marketplace provider has to ACCEPT or DECLINE.
// After this, the job moves to provider_no_response and the client is notified.
export const MARKETPLACE_RESPONSE_TIMEOUT_HOURS = 24;

// ─── City codes ─────────────────────────────────────────────────────────────
export const VALID_CITY_CODES     = new Set(["VAN", "VIC", "YYC", "YEG", "YYZ", "MTL"]);
export const VALID_CATEGORY_CODES = new Set(Object.keys(CATEGORY_NAMES));

// City code → canonical names and common aliases used in service_cities TEXT[].
// SHORT aliases (< 4 chars) match only exactly.
// LONGER aliases (>= 5 chars) also match as substrings — see providerCoversCity().
export const CITY_CODE_TO_NAMES: Record<string, string[]> = {
  VAN: ["Vancouver", "vancouver", "Metro Vancouver", "Metro Van", "Greater Vancouver", "Lower Mainland"],
  VIC: ["Victoria",  "victoria"],
  YYC: ["Calgary",   "calgary"],
  YEG: ["Edmonton",  "edmonton"],
  YYZ: ["Toronto",   "toronto",  "GTA", "Greater Toronto", "Greater Toronto Area"],
  MTL: ["Montreal",  "montreal", "Montréal", "montréal"],
};

/**
 * Returns true if a provider's service_cities array covers the given city code.
 *
 * Matching rules (ordered, all case-insensitive):
 *   1. Exact match against any alias               e.g. "Vancouver" = "Vancouver" ✓
 *   2. Provider city STRING contains a long alias  e.g. "Greater Vancouver Area" ⊇ "vancouver" ✓
 *   3. A long alias contains the provider city     e.g. "Metro Vancouver" ⊇ "Metro Van" ✓
 *
 * "Long" = alias length >= 5 chars. This prevents "van" matching "Savannah",
 * and "GTA" matching via substring (GTA must exact-match).
 *
 * service_area TEXT fallback is handled by the caller, not here.
 */
export function providerCoversCity(
  serviceCities: string[] | null | undefined,
  cityCode: string,
): boolean {
  if (!serviceCities || serviceCities.length === 0) return false;
  const aliases = CITY_CODE_TO_NAMES[cityCode];
  if (!aliases || aliases.length === 0) return false;

  return serviceCities.some((city) => {
    const cityLower = city.toLowerCase().trim();
    if (!cityLower) return false;

    return aliases.some((alias) => {
      const aliasLower = alias.toLowerCase();

      // Rule 1: exact match
      if (cityLower === aliasLower) return true;

      // Rules 2 & 3: substring — only for aliases >= 5 chars to avoid false positives
      if (aliasLower.length >= 5) {
        // Rule 2: provider's city string contains the alias
        // e.g. "greater vancouver area".includes("vancouver") ✓
        if (cityLower.includes(aliasLower)) return true;

        // Rule 3: alias contains what provider wrote (provider used an abbreviation)
        // e.g. "metro vancouver".includes("metro van") ✓
        // Guard: provider's city string must also be >= 4 chars (rejects "bc", "on")
        if (cityLower.length >= 4 && aliasLower.includes(cityLower)) return true;
      }

      return false;
    });
  });
}

// ─── Category code normalization ─────────────────────────────────────────────
//
// Handles the reality that provider_accounts.additional_services (TEXT[]) may
// contain values in any of these formats from different versions of the form:
//   - Code:         "PLM", "CLN"
//   - Slug:         "plumbing", "yard-work"
//   - Spaced slug:  "yard work", "moving"
//   - Display name: "Plumbing", "Moving / Transport", "Cleaning"
//   - Mixed case:   "PLUMBING", "Yard Work"
//   - Partial:      "Moving", "Electric"
//
// Returns the canonical 3-letter category code, or null if unresolvable.
// Used by job-dispatch eligibility filter and anywhere category matching is needed.

// Display name → code (built from CATEGORY_NAMES for exact matches)
const DISPLAY_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

// Additional common variations not covered by CATEGORY_NAMES or SLUG_TO_CATEGORY_CODE
const EXTRA_ALIASES: Record<string, string> = {
  "plumber":           "PLM",
  "plumbers":          "PLM",
  "cleaner":           "CLN",
  "cleaners":          "CLN",
  "house cleaning":    "CLN",
  "home cleaning":     "CLN",
  "maid":              "CLN",
  "electrician":       "ELC",
  "electricians":      "ELC",
  "electric":          "ELC",
  "painter":           "PLT",
  "painters":          "PLT",
  "painting services": "PLT",
  "air conditioning":  "HVC",
  "furnace":           "HVC",
  "heating":           "HVC",
  "movers":            "MVG",
  "moving services":   "MVG",
  "transport":         "MVG",
  "transportation":    "MVG",
  "lawn care":         "YRD",
  "lawn":              "YRD",
  "landscaping":       "YRD",
  "snow removal":      "YRD",
  "general repairs":   "HND",
  "repairs":           "HND",
  "general handyman":  "HND",
};

export function normalizeToCategoryCode(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Direct code match (already in correct format)
  const upper = trimmed.toUpperCase().replace(/[^A-Z]/g, "");
  if (VALID_CATEGORY_CODES.has(upper)) return upper;

  const lower = trimmed.toLowerCase();

  // 2. Exact slug match (e.g. "plumbing", "yard-work")
  if (SLUG_TO_CATEGORY_CODE[lower]) return SLUG_TO_CATEGORY_CODE[lower];

  // 3. Slug with spaces instead of hyphens (e.g. "yard work")
  const spaced = lower.replace(/-/g, " ");
  if (SLUG_TO_CATEGORY_CODE[spaced]) return SLUG_TO_CATEGORY_CODE[spaced];

  // 4. Exact display name match (e.g. "Moving / Transport", "HVAC")
  if (DISPLAY_NAME_TO_CODE[lower]) return DISPLAY_NAME_TO_CODE[lower];

  // 5. Extra alias map (handles common variations and misspellings)
  if (EXTRA_ALIASES[lower]) return EXTRA_ALIASES[lower];

  // 6. Partial slug match — category slug starts with what was provided
  //    e.g. "electric" → "electrical" (ELC); min 4 chars to avoid false positives
  if (lower.length >= 4) {
    for (const [slug, code] of Object.entries(SLUG_TO_CATEGORY_CODE)) {
      const slugSpaced = slug.replace(/-/g, " ");
      if (slugSpaced.startsWith(lower) || lower.startsWith(slugSpaced)) return code;
      if (slug.startsWith(lower) || lower.startsWith(slug)) return code;
    }

    // 7. Display name starts-with (e.g. "Moving" → "Moving / Transport")
    for (const [name, code] of Object.entries(DISPLAY_NAME_TO_CODE)) {
      const firstName = name.split(" ")[0]; // first word of display name
      if (firstName && firstName.length >= 4 && lower.startsWith(firstName)) return code;
      if (firstName && firstName.length >= 4 && firstName.startsWith(lower)) return code;
    }

    // 8. Extra aliases partial scan
    for (const [alias, code] of Object.entries(EXTRA_ALIASES)) {
      if (alias.startsWith(lower) && lower.length >= 5) return code;
    }
  }

  return null;
}

// ─── Operational event weights (provisional) ────────────────────────────────
//
// Predefined weights for admin-confirmed factual negative reliability events.
//
// Policy (locked for v1):
//   Admin CONFIRMS whether an event occurred.
//   Admin does NOT set or vary the weight — weights are code-defined here.
//   This enforces structured, non-arbitrary reliability impact.
//
// manual_positive and manual_negative are NOT in this map.
// They are internal-only signals, excluded from the public reliability score
// path in v1. They are recorded in reliability_inputs but apply-reliability
// skips them with zero score contribution.
//
// apply-reliability also maintains its own copy of these constants.
// The two MUST remain in sync. This shared file is the single source of truth.
//
// PROVISIONAL: weights must be reviewed and approved before treating as
// locked business rules. The formula is designed for easy recalibration.
export const OPERATIONAL_EVENT_WEIGHTS: Readonly<Record<string, number>> = {
  payment_failure:      -10,  // claimed lead, payment window expired unpaid
  accepted_no_proceed:  -15,  // accepted, failed to proceed before appointment
  no_show:              -20,  // had appointment commitment, failed to appear
  poor_eta:              -5,  // ETA reminder was sent; admin confirms no ETA given
};

// These two event types are mutually exclusive per provider/job.
// accepted_no_proceed = disengaged before any appointment was established.
// no_show             = failed to appear after appointment was established.
// Only one may be recorded per (provider_slug, job_id).
// Enforced at both the application layer (record-operational-event) and
// the DB layer (reliability_inputs_mutually_exclusive_events_idx).
export const MUTUALLY_EXCLUSIVE_NEGATIVE_EVENTS: ReadonlySet<string> = new Set([
  "accepted_no_proceed",
  "no_show",
]);

// ─── Inbound keyword constants ───────────────────────────────────────────────
export const KW_ACCEPT    = "ACCEPT";
export const KW_PASS      = "PASS";
export const KW_DECLINE   = "DECLINE";
export const KW_HELP      = "HELP";
export const KW_KEEP_OPEN = "KEEP OPEN";
export const KW_CANCEL    = "CANCEL";
export const KW_YES       = "YES";
export const KW_NO        = "NO";

/** Normalizes inbound message body for keyword matching. */
export function normalizeKeyword(body: string): string {
  return body.trim().toUpperCase().replace(/[^A-Z ]/g, "");
}

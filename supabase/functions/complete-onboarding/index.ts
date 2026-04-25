// TaskLeaders — Edge Function: complete-onboarding
// Contract: POST /complete-onboarding
// Body: { slug: string, ...profile fields }
// Updates the providers record with profile setup data, sets status → active, timestamps onboarded_at.
// Called on profile-setup form submission when a slug is present in the URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractMunicipalityFromAddress } from "../_shared/constants.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function error(code: string, message: string, status = 400) {
  return json({ ok: false, error: { code, message } }, status);
}

function cleanString(v: unknown): string {
  return String(v ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true, data: {} });
  if (req.method !== "POST") {
    return error("bad_request", "Method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return error("server_error", "Missing server configuration", 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("bad_request", "Invalid JSON body");
  }

  const slug = cleanString(body.slug).toLowerCase();
  if (!slug) {
    return error("bad_request", "Missing required field: slug");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Verify the provider exists and is in the right state
  const { data: existing, error: fetchError } = await supabase
    .from("provider_accounts")
    .select("id, status")
    .eq("slug", slug)
    .single();

  if (fetchError || !existing) {
    return error("not_found", "Provider not found", 404);
  }

  // Build the update payload — only include non-empty overrides
  // Guard: do not regress an already-active provider back to pending_approval.
  // complete-onboarding is called both from initial setup and from the return/edit
  // management page — active providers must stay active after a profile update.
  const updates: Record<string, unknown> = {
    status: existing.status === "active" ? "active" : "pending_approval",
    onboarded_at: new Date().toISOString(),
  };

  if (cleanString(body.firstName))      updates.first_name      = cleanString(body.firstName);
  if (cleanString(body.lastName))       updates.last_name       = cleanString(body.lastName);
  if (cleanString(body.businessName))   updates.business_name   = cleanString(body.businessName);
  if (cleanString(body.email))          updates.email           = cleanString(body.email).toLowerCase();
  if (cleanString(body.whatsapp))       updates.whatsapp_number = cleanString(body.whatsapp);
  if (cleanString(body.baseCity))       updates.service_area    = cleanString(body.baseCity);
  if (cleanString(body.primaryService)) updates.primary_service = cleanString(body.primaryService);
  if (cleanString(body.bio))            updates.short_description = cleanString(body.bio);
  if (cleanString(body.hourlyRate))     updates.base_rate       = cleanString(body.hourlyRate);
  if (cleanString(body.profilePhoto))   updates.profile_photo   = cleanString(body.profilePhoto);

  // Extended profile fields
  if (cleanString(body.displayNameType)) updates.display_name_type = cleanString(body.displayNameType);
  if (cleanString(body.backupPhone))     updates.backup_phone      = cleanString(body.backupPhone);
  if (cleanString(body.address1))        updates.address_line1     = cleanString(body.address1);
  if (cleanString(body.address2))        updates.address_line2     = cleanString(body.address2);
  if (cleanString(body.city))            updates.city              = cleanString(body.city);
  if (cleanString(body.province))        updates.province          = cleanString(body.province);
  if (cleanString(body.postalCode))      updates.postal_code       = cleanString(body.postalCode);

  // Array fields — only save if non-empty arrays are provided
  if (Array.isArray(body.serviceCities) && (body.serviceCities as unknown[]).length > 0) {
    updates.service_cities = (body.serviceCities as unknown[]).map((v) => cleanString(v)).filter(Boolean);
  }

  // Derive structured municipality_codes from the same inputs that drive
  // service_area + service_cities. Mirrors the post-backfill canonical shape
  // (home-base first, then selected serviceCities order, deduped) so that new
  // providers join the dataset already populated and the one-shot backfill
  // doesn't decay over time. Names are mapped to registry codes via the shared
  // extractMunicipalityFromAddress helper. Names that don't map are silently
  // skipped — we never invent a code. We only write municipality_codes when at
  // least one input was provided AND yielded a recognized code; otherwise the
  // column is left untouched (preserving any prior valid value through partial
  // edits to unrelated profile fields).
  {
    const baseCityRaw     = cleanString(body.baseCity);
    const hasBaseCity     = baseCityRaw.length > 0;
    const hasServiceCities = Array.isArray(body.serviceCities) && (body.serviceCities as unknown[]).length > 0;
    if (hasBaseCity || hasServiceCities) {
      const seen: Set<string> = new Set();
      const ordered: string[] = [];

      const addCode = (raw: string) => {
        const hit = extractMunicipalityFromAddress(raw);
        if (hit && !seen.has(hit.code)) {
          seen.add(hit.code);
          ordered.push(hit.code);
        }
      };

      if (hasBaseCity) addCode(baseCityRaw);
      if (hasServiceCities) {
        for (const raw of body.serviceCities as unknown[]) {
          const name = cleanString(raw);
          if (name) addCode(name);
        }
      }

      if (ordered.length > 0) {
        updates.municipality_codes = ordered;
      }
    }
  }

  if (Array.isArray(body.additionalServices) && (body.additionalServices as unknown[]).length > 0) {
    updates.additional_services = (body.additionalServices as unknown[]).map((v) => cleanString(v)).filter(Boolean);
  }
  if (Array.isArray(body.workPhotos) && (body.workPhotos as unknown[]).length > 0) {
    updates.work_photos = (body.workPhotos as unknown[]).map((v) => cleanString(v)).filter(Boolean);
  }
  // Per-service rates: object where keys are service slugs and values are hourly rates
  if (body.serviceRates && typeof body.serviceRates === "object" && !Array.isArray(body.serviceRates)) {
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.serviceRates as Record<string, unknown>)) {
      // Normalise keys to lowercase so JSONB scans in public-category and public-homepage
      // always find a match regardless of how the key was entered by the client.
      const key = cleanString(k).toLowerCase();
      const val = parseFloat(String(v));
      if (key && Number.isFinite(val) && val > 0) rates[key] = val;
    }
    if (Object.keys(rates).length > 0) updates.service_rates = rates;
  }

  const { error: updateError } = await supabase
    .from("provider_accounts")
    .update(updates)
    .eq("slug", slug);

  if (updateError) {
    return error("server_error", updateError.message, 500);
  }

  return json({ ok: true, data: { slug, status: "active" } });
});

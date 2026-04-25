// TaskLeaders — Edge Function: create-setup-intent
// Contract: POST /create-setup-intent
// Body: { slug: string }
//
// Creates (or retrieves) a Stripe Customer for the provider, then creates
// a SetupIntent for off-session card storage. Returns { client_secret }
// to the frontend for stripe.confirmCardSetup().
//
// Auth: slug = identity (same model as complete-onboarding).
// If stripe_customer_id already exists on provider_accounts, it is reused.
// stripe_customer_id is written back to provider_accounts if newly created.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function stripePost(path: string, params: Record<string, string>, authHeader: string) {
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("TASKLEADERS_SERVICE_ROLE_KEY");
  const stripeKey      = Deno.env.get("STRIPE_SECRET_KEY");

  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: "Missing server configuration" }, 500);
  if (!stripeKey) return json({ ok: false, error: "Stripe not configured" }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }

  const slug = String(body.slug ?? "").trim().toLowerCase();
  if (!slug) return json({ ok: false, error: "slug is required" }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const stripeAuth = "Basic " + btoa(`${stripeKey}:`);

  const { data: provider, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, first_name, last_name, email, stripe_customer_id")
    .eq("slug", slug)
    .single();

  if (provErr || !provider) return json({ ok: false, error: "Provider not found" }, 404);

  // Get or create Stripe Customer
  let customerId = provider.stripe_customer_id as string | null;

  if (!customerId) {
    const name = [provider.first_name, provider.last_name].filter(Boolean).join(" ");
    const custParams: Record<string, string> = {
      "metadata[provider_slug]": slug,
    };
    if (name)             custParams["name"]  = name;
    if (provider.email)   custParams["email"] = provider.email;

    const custRes  = await stripePost("/customers", custParams, stripeAuth);
    const custData = await custRes.json();

    if (!custRes.ok || !custData.id) {
      return json({ ok: false, error: custData.error?.message ?? "Failed to create Stripe Customer" }, 502);
    }
    customerId = custData.id as string;

    await supabase
      .from("provider_accounts")
      .update({ stripe_customer_id: customerId })
      .eq("slug", slug);
  }

  // Create SetupIntent
  const siRes  = await stripePost("/setup_intents", {
    customer:                 customerId,
    usage:                    "off_session",
    "payment_method_types[]": "card",
  }, stripeAuth);
  const siData = await siRes.json();

  if (!siRes.ok || !siData.client_secret) {
    return json({ ok: false, error: siData.error?.message ?? "Failed to create SetupIntent" }, 502);
  }

  return json({ ok: true, data: { client_secret: siData.client_secret } });
});

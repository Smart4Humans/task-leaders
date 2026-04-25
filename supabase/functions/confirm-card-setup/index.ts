// TaskLeaders — Edge Function: confirm-card-setup
// Contract: POST /confirm-card-setup
// Body: { slug: string, payment_method_id: string }
//
// Called by the frontend after stripe.confirmCardSetup() succeeds.
// Attaches the PaymentMethod to the provider's Stripe Customer,
// sets it as the default off-session payment method, and writes
// stripe_payment_method_id + card_on_file = true to provider_accounts.
//
// Auth: slug = identity (same model as complete-onboarding).
// Idempotent: re-calling with a new payment_method_id replaces the stored one.

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

  const slug            = String(body.slug             ?? "").trim().toLowerCase();
  const paymentMethodId = String(body.payment_method_id ?? "").trim();
  if (!slug)            return json({ ok: false, error: "slug is required" }, 400);
  if (!paymentMethodId) return json({ ok: false, error: "payment_method_id is required" }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const stripeAuth = "Basic " + btoa(`${stripeKey}:`);

  const { data: provider, error: provErr } = await supabase
    .from("provider_accounts")
    .select("slug, stripe_customer_id")
    .eq("slug", slug)
    .single();

  if (provErr || !provider) return json({ ok: false, error: "Provider not found" }, 404);

  const customerId = provider.stripe_customer_id as string | null;
  if (!customerId) return json({ ok: false, error: "No Stripe Customer on record — call create-setup-intent first" }, 400);

  // Attach payment method to customer
  const attachRes  = await stripePost(
    `/payment_methods/${paymentMethodId}/attach`,
    { customer: customerId },
    stripeAuth,
  );
  const attachData = await attachRes.json();

  if (!attachRes.ok) {
    // 'already attached' is not a failure
    if (attachData.error?.code !== "payment_method_already_attached") {
      return json({ ok: false, error: attachData.error?.message ?? "Failed to attach payment method" }, 502);
    }
  }

  // Set as default off-session payment method on the Customer
  const updateRes  = await stripePost(
    `/customers/${customerId}`,
    { "invoice_settings[default_payment_method]": paymentMethodId },
    stripeAuth,
  );
  const updateData = await updateRes.json();

  if (!updateRes.ok) {
    return json({ ok: false, error: updateData.error?.message ?? "Failed to set default payment method" }, 502);
  }

  // Write to provider_accounts
  const { error: dbErr } = await supabase
    .from("provider_accounts")
    .update({
      stripe_payment_method_id: paymentMethodId,
      card_on_file:             true,
    })
    .eq("slug", slug);

  if (dbErr) return json({ ok: false, error: dbErr.message }, 500);

  return json({ ok: true, data: { card_on_file: true } });
});

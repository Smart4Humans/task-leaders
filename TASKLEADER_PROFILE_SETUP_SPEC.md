# TaskLeader Profile Setup — MVP Specification

> **Governing Source:** TASKLEADERS_MVP_WORKING_BRIEF.md  
> **Audience:** Provider-facing (TaskLeaders creating their public profile)  
> **Date:** March 10, 2026  
> **Status:** MVP Definition

---

## Purpose

The **TaskLeader Profile Setup** is the provider-facing flow used to create and manage the information that appears on the **TaskLeader Public Profile**.

It must be:
- Simple and practical (not overbuilt SaaS)
- Trust-first (collects credible information)
- Easy to complete (minimal friction)
- Aligned with the public profile data model

---

## Final Section Order

```
1. Header — TaskLeaders branding + progress indicator
2. Identity Section — Who you are
3. Location Section — Where you're based
4. Contact Section — How customers reach you
5. Coverage Section — Where you serve
6. Services Section — What you do and your rates
7. Payment Section — Subscription payment
8. Review & Submit — Final check before submission
```

---

## Field Specifications

### Section 1: Identity (Required)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| first_name | First Name | text | ✅ | Display name on public profile |
| last_name | Last Name | text | ✅ | |
| business_name | Business Name | text | ❌ | Optional, shown if provided |
| email | Email | email | ✅ | For account communications |

**Public Profile Mapping:**
- `display_name` = First + Last (or Business Name if provided)

---

### Section 2: Location (Required)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| address_1 | Address Line 1 | text | ✅ | Internal, not shown publicly |
| address_2 | Address Line 2 | text | ❌ | Apartment, suite, etc. |
| base_city | Base Location | select | ✅ | **Approved city list only** |
| province | Province | select | ✅ | BC default, others available |

**Approved City List (17 cities):**
Vancouver, Surrey, Burnaby, Richmond, Coquitlam, New Westminster,
North Vancouver, Port Coquitlam, Maple Ridge, Langley, White Rock,
Port Moody, Pitt Meadows, Delta, Abbotsford, Chilliwack, Mission

**Public Profile Mapping:**
- `base_location` = base_city (city only, shown in hero)

---

### Section 3: Contact (Required)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| phone | Phone Number | tel | ✅ | Business phone |
| whatsapp | WhatsApp Number | tel | ✅ | **Primary customer contact method** |

**Public Profile Mapping:**
- WhatsApp used for "Connect" button deep link

---

### Section 4: Coverage (Required)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| service_cities | Additional Cities | multi-select | ❌ | Toggle cities beyond base |
| select_all_cities | Select All Cities | checkbox | ❌ | Shortcut if covers all |

**Logic:**
- Base city is automatically included
- Provider can toggle additional cities from approved list
- "Select All" shortcut adds all 17 cities
- Service Areas = base_city + service_cities + neighborhoods (entered as text)

**Public Profile Mapping:**
- `service_areas` = combined list of cities + neighborhoods

---

### Section 5: Services (Required)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| categories | Service Categories | multi-select | ✅ | Toggle from approved list |
| primary_category | Primary Category | select | ✅ | Main service shown in hero |
| rates | Hourly Rates | number[] | ✅ | One rate per selected category |

**Approved Categories (9):**
- Handyman, Plumbing, Electrical, Painting, Cleaning,
- Furniture Assembly, Moving Help, Yard Work, HVAC

**Rate Input:**
- Show rate field for each selected category
- Label: "[Category] Rate ($/hour)"
- Minimum: $20, Maximum: $200
- Default: placeholder based on category average

**Public Profile Mapping:**
- `services[]` = array of {category, rate}
- `primary_category` = selected primary

---

### Section 6: Payment (Required)

**MVP Decision:** Collect credit card on same page (simpler), not separate step.

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| card_name | Name on Card | text | ✅ | |
| card_number | Card Number | text | ✅ | Stripe Elements or basic validation |
| card_expiry | Expiry (MM/YY) | text | ✅ | |
| card_cvc | CVC | text | ✅ | |

**Note:** For true MVP, could use Stripe Payment Element or defer to post-approval.

---

### Section 7: Review & Submit

**Summary Card showing:**
- Name/Business
- Base Location
- Categories selected (with rates)
- Coverage area
- WhatsApp number (for verification)

**Submit Button:** "Submit Application"
**Helper text:** "We'll review your application and notify you within 24-48 hours."

---

## Required vs Optional Summary

| Section | Required Fields | Optional Fields |
|---------|-----------------|-----------------|
| Identity | First, Last, Email | Business Name |
| Location | Address 1, Base City, Province | Address 2 |
| Contact | Phone, WhatsApp | — |
| Coverage | — | Additional cities |
| Services | Categories, Primary, Rates | — |
| Payment | All card fields | — |

---

## Data Model Mapping

```javascript
// TaskLeader Profile Setup → Public Profile
const profileData = {
  // Identity → Public Profile
  display_name: business_name || `${first_name} ${last_name}`,
  
  // Location → Public Profile
  base_location: base_city, // "Vancouver"
  service_areas: [base_city, ...service_cities, ...neighborhoods],
  
  // Contact → Public Profile
  whatsapp_number: whatsapp,
  
  // Services → Public Profile
  primary_category: primary_category,
  services: categories.map(cat => ({
    category: cat,
    rate: rates[cat]
  })),
  
  // Internal only (not public)
  email: email,
  phone: phone,
  address: { address_1, address_2, city: base_city, province }
};
```

---

## Excluded / Deferred for MVP

| Feature | Why Excluded | When to Add |
|---------|--------------|-------------|
| Profile photo upload | Complexity, can add post-approval | Phase 2 |
| Bio/description text | Can be added by admin initially | Phase 2 |
| Response time setting | Use default initially | Phase 2 |
| Availability calendar | Too complex for MVP | Post-MVP |
| Multiple addresses | Simplify to one base | Post-MVP |
| Insurance/credential upload | Manual verification initially | Phase 2 |
| Real-time payment processing | Stripe integration complexity | Phase 2 (collect card, charge later) |
| Save draft / resume later | Simplify to single session | Post-MVP |

---

## Design Principles

1. **One page, multiple sections** — Not a multi-step wizard (simpler)
2. **Sticky progress** — Show completion status as user scrolls
3. **Inline validation** — Validate on blur, not just on submit
4. **Smart defaults** — Pre-select reasonable values
5. **Clear labels** — No jargon, plain language
6. **Mobile-first** — Easy to complete on phone

---

## Best Base File

**Recommendation:** Use `v0.2/become-task-leader.html` as base
- Already has form structure
- Has TaskLeaders branding
- Has form styling patterns
- Can be evolved into full profile setup

---

*End of specification.*

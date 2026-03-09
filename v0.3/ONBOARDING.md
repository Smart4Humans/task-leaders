# TaskLeaders — Onboarding Flow Documentation

**Version:** 1.0  
**Last Updated:** March 9, 2026

---

## Overview

This document describes the complete onboarding flows for both **providers** (service professionals) and **customers** using TaskLeaders.

---

## Provider Onboarding Flow

### Step 1: Apply

**Entry Point:** Homepage → "Become a TL" or direct link to `become-task-leader.html`

**Form Fields:**
- Contact Name (required)
- Business Name (required)
- WhatsApp Number (required)
- Service Category (required)
- Service Area (required)
- Hourly Rate (required, min $15)
- Short Description (required)

**Process:**
1. Provider fills out application form
2. Clicks "Submit Application"
3. Data saved to database with `approved: false`
4. Success message displayed

**Post-Submission:**
```
"Application received. We will contact you via WhatsApp within 24 hours for verification."
```

**Status:** `PENDING_REVIEW`

---

### Step 2: Admin Approval

**Entry Point:** `admin.html`

**Admin Actions:**
1. Views pending applications in moderation queue
2. Reviews provider details
3. Clicks "Approve" or "Reject"

**On Approval:**
- Provider status changes to `approved: true`
- System sends WhatsApp message with unique setup link
- Status: `APPROVED_PENDING_SETUP`

**WhatsApp Message Template:**
```
Hi [Name]! Your TaskLeaders application has been approved. 

Complete your profile to start receiving customer inquiries:
[unique-link]

— TaskLeaders Team
```

---

### Step 3: Provider Setup

**Entry Point:** Unique link → `provider-setup.html`

**Form Fields:**
- Business Name (required)
- Contact Name (required)
- WhatsApp Number (required, verified)
- Category (required)
- Service Area (required)
- Hourly Rate (required)
- Short Description (required, max 200 chars)
- Logo/Photo (optional)
- Stripe Payment Method (required)
- Agreement Checkbox (required)

**Agreement Text:**
```
I agree to:
• Respond to customer inquiries within 24 hours
• Maintain 80%+ response rate
• Provide accurate service information
```

**Process:**
1. Provider completes all required fields
2. Enters Stripe payment method (card on file)
3. Checks agreement checkbox
4. Clicks "Complete Setup"
5. Profile saved with all details

**Status:** `SETUP_COMPLETE_PENDING_LIVE`

---

### Step 4: Go Live

**Activation:**
1. Provider sees "Go Live" button after setup
2. Clicks "Go Live" to activate profile
3. Profile immediately appears in category listings
4. Provider can toggle availability on/off anytime

**Status:** `LIVE`

---

## Customer WhatsApp Inquiry Flow

### Step 1: Browse Category

**Entry Point:** Homepage → Category selection → `category.html`

**Customer Sees:**
- Compact leaderboard of providers
- Sort options: Response Time, Reliability, Price
- WhatsApp button on each provider row

---

### Step 2: Initiate Contact

**Action:** Customer clicks "💬 WhatsApp" button on provider row

**Modal Appears:**
```
┌─────────────────────────────┐
│  Contact [Provider Name]    │
├─────────────────────────────┤
│  Message preview:           │
│  "Hi! I found you on        │
│   TaskLeaders and need      │
│   help with [Category]."    │
├─────────────────────────────┤
│  ☐ I agree to receive       │
│    follow-up messages from  │
│    TaskLeaders related to   │
│    this inquiry.            │
├─────────────────────────────┤
│  [Continue to WhatsApp]     │
│  [Cancel]                   │
└─────────────────────────────┘
```

**Consent Checkbox:**
- Unchecked by default
- Required for TaskLeaders to send follow-up messages
- Separate from any provider agreement

---

### Step 3: Continue to WhatsApp

**Action:** Customer clicks "Continue to WhatsApp"

**System Logs:**
```javascript
{
  provider_id: "prov_xxx",
  customer_consent: true/false,
  timestamp: "2026-03-09T...",
  category: "painting"
}
```

**Redirect:**
```
https://wa.me/[provider_number]?text=Hi!%20I%20found%20you%20on%20TaskLeaders...
```

---

### Step 4: Follow-Up (if consented)

**24 hours after inquiry (if customer opted in):**
```
Hi! How did it go with [Provider Name]? 

Reply with a rating 1-5 to help other customers.
```

**No response follow-up:**
```
Hi! Haven't heard back from [Provider Name]?

Here are 3 other [category] providers available now:
[links]
```

---

## Status Summary

### Provider Statuses

| Status | Description | Visible to Customers? |
|--------|-------------|----------------------|
| `PENDING_REVIEW` | Applied, awaiting admin approval | No |
| `APPROVED_PENDING_SETUP` | Approved, needs to complete setup | No |
| `SETUP_COMPLETE_PENDING_LIVE` | Setup done, needs to click "Go Live" | No |
| `LIVE` | Active and visible in listings | Yes |
| `PAUSED` | Provider toggled off availability | No |

### Customer Consent States

| State | Can Send Follow-Ups? |
|-------|---------------------|
| Consent given | Yes |
| No consent | No (only session messages within 24h) |
| Opted out | No |

---

## Key Files

| File | Purpose |
|------|---------|
| `homepage.html` | Entry point, category selection |
| `category.html` | Provider leaderboard, WhatsApp modal |
| `become-task-leader.html` | Provider application form |
| `admin.html` | Admin moderation queue |
| `provider-setup.html` | Post-approval provider setup |
| `js/db.js` | Data layer and storage |

---

## Metrics Tracked

### Provider Metrics
- Response time (median minutes)
- Reliability score (0-5, displayed as %)
- Response rate (% within 24h)
- Hourly rate

### Customer Metrics
- Inquiries sent
- Consent rate
- Follow-up engagement
- Conversion to booked jobs

---

## Future Enhancements (Post-MVP)

- [ ] Automated WhatsApp verification codes
- [ ] Real Stripe integration
- [ ] Provider availability toggle
- [ ] Customer accounts (optional)
- [ ] Review system expansion
- [ ] Multi-city support

---

*This document should be updated as flows evolve.*

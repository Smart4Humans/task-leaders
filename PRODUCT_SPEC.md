> Note: This document is the original baseline vision as of March 9, 2026.
> The current MVP source of truth is TASKLEADERS_MVP_WORKING_BRIEF.md.

# TaskLeaders — Product Specification


**Version:** 1.1  
**Last Updated:** March 9, 2026  
**Status:** MVP Development

---

## Project Overview

| Attribute | Value |
|-----------|-------|
| **Name** | TaskLeaders |
| **Type** | Hyper-local service provider marketplace |
| **Core Idea** | Customers find local service providers and contact them directly via WhatsApp |
| **Monetization** | Provider subscriptions (no customer fees, no commissions) |
| **Differentiation** | Direct WhatsApp communication, no middleman, speed-ranked |

---

## Core Principle

The platform **only facilitates introductions** between customers and providers.

- ❌ Does NOT handle payments
- ❌ Does NOT handle bookings
- ❌ Customers do NOT need accounts
- ✅ Only connects customers to providers via WhatsApp

---

## MVP Goals

### Success Criteria

| Metric | Target |
|--------|--------|
| Providers onboarded | 20–30 |
| Real customer conversations | 20+ |

### Rule

**Do NOT add complex systems before achieving these numbers.**

Prioritize simplicity and speed of launch over technical perfection.

Every feature must answer: *"Does this help customers connect with providers faster?"*

---

## User Flows

### Customer Flow

```
Homepage
    ↓
Select Category
    ↓
View Ranked Providers
    ↓
Message Provider via WhatsApp
```

### Provider Flow

```
Submit Onboarding Form
    ↓
Manual Admin Verification
    ↓
Admin Approval
    ↓
Appear in Category Rankings
```

---

## Communication System

All communication happens through **WhatsApp**.

Providers receive messages via:
```
https://wa.me/{phone_number}
```

No internal messaging system is needed.

---

## Public Ranking Metrics

Providers are evaluated using **three visible metrics**:

### 1. Response Time
Median time between customer first message and provider's meaningful reply.

**Display:** `⚡ Responds in ~3 min`

### 2. Reliability
Average customer experience rating (1–5 stars).

Collected via WhatsApp follow-up.

**Display:** `⭐ Reliability 4.8`

### 3. Price
Provider hourly rate.

**Display:** `💲 $85/hr`

---

## Internal Metric

### Response Rate

**Definition:** messages replied to within 24 hours / messages received

**Requirement:** ResponseRate ≥ 80%

---

## Category Page Structure

Each category page contains:

1. **Category header**
2. **Activity indicators**
3. **Recommended providers**
4. **Sort options**
5. **Provider list**

### Activity Indicators

Show small real-time signals to make the marketplace feel active.

**Example:**
```
🟢 5 providers available now
⚡ Avg response time: 4 minutes
```

**Rule:** Avoid showing unrealistic large numbers.

### Recommended Providers

Each category page shows **3 recommended providers**.

**Selection:**
- Top 5 providers by composite score are eligible
- Randomly display 3 for fairness

**Composite Score Formula:**
```
CompositeScore =
  0.45 * response_speed_score +
  0.35 * reliability_score +
  0.20 * price_score
```

---

## Provider Card Format

Provider cards must display:

- Name
- Response Time
- Reliability Score
- Hourly Price
- Response Rate (optional)
- WhatsApp Contact Button

**Example:**
```
Mike Johnson Plumbing

⚡ Responds in ~3 min
⭐ Reliability 4.9
💲 $90/hr

96% response rate

[Message on WhatsApp]
```

---

## Homepage Structure

Homepage contains:

- Search bar
- Category cards
- Provider onboarding CTA

### Category Cards

Each card shows:
- Category name
- Providers available now
- Average response time

**Example:**
```
Plumbing
5 available now
Avg response: 4 min
```

---

## Provider Onboarding Flow

### Step 1: Initial Application

**Form Fields:**
- Name
- Business Name
- WhatsApp Phone Number
- Service Category
- Service Area
- Hourly Rate
- Short Description

**Post-Submission:**
```
"Application received. We will contact you via WhatsApp for verification."
```

---

### Step 2: Admin Verification

Admin reviews application via minimal admin panel:
- View application details
- Approve or reject
- If approved: trigger setup email/WhatsApp

---

### Step 3: Provider Setup Page (Post-Approval)

**Purpose:** Collect final details and payment before profile goes live.

**Access:** Unique link sent via WhatsApp/email after admin approval.

**Required Fields:**

| Field | Required | Notes |
|-------|----------|-------|
| Business Name | Yes | Displayed on profile |
| Contact Name | Yes | Personal name for communications |
| WhatsApp Number | Yes | Verified via SMS/code |
| Category | Yes | Primary service category |
| Service Area | Yes | Neighborhoods/cities served |
| Hourly Rate | Yes | Displayed on profile |
| Short Description | Yes | Max 200 characters |
| Logo | No | Optional, displayed on profile |
| Stripe Payment Method | Yes | Card on file for subscription |

**Validation Rules:**
- All required fields must be completed
- WhatsApp number must be verified (6-digit code)
- Hourly rate must be numeric, min $15
- Description max 200 characters
- Logo: max 2MB, JPG/PNG only

**Stripe Integration:**
- Collect card details via Stripe Elements
- Store payment method (not charged until trial ends)
- Show subscription summary:
  ```
  Subscription: $29/month (Starter Plan)
  Trial: 2 months FREE
  First charge: [Date 2 months from now]
  ```

**Completion Flow:**
```
Provider submits setup form
    ↓
System validates all fields
    ↓
WhatsApp number verified
    ↓
Payment method stored (Stripe)
    ↓
Profile created → Status: PENDING_LIVE
    ↓
Provider sees: "Your profile is ready! Toggle 'Available' when you're ready for customers."
    ↓
Provider appears in category rankings
```

**Pre-Live Checklist Displayed:**
```
☑ Business name set
☑ Contact name added
☑ WhatsApp verified
☑ Category selected
☑ Service area defined
☑ Hourly rate set
☑ Description added
☑ Payment method on file

[Go Live] ← Enabled when all checked
```

**Note:** Profile is NOT visible to customers until provider clicks "Go Live" or toggles availability.

---

## Admin Interface

Minimal admin panel required.

**Features:**
- View applications
- Approve providers
- Edit provider data
- Remove providers

---

## UI Design Principles

The UI should remain:
- **Minimal**
- **Fast**
- **Utility-first**

### Avoid:
- Heavy animations
- Complex dashboards
- Over-designed components

The platform should feel like a **practical tool**, not a polished SaaS product.

---

## Strategic Positioning

TaskLeaders differentiates from TaskRabbit and Thumbtack by:

| Feature | TaskLeaders | Big Players |
|---------|-------------|-------------|
| Communication | Direct WhatsApp | In-app messaging |
| Fees | No commissions | 15–30% commission |
| Provider Model | Subscription | Commission |
| Focus | Response speed | Volume |
| Accounts | None for customers | Required |

---

## Development Rules

1. **Simplicity over perfection**
2. **Speed over features**
3. **Launch over polish**
4. **Test with real users ASAP**

---

## File Structure

```
task-leaders-deploy/
├── PRODUCT_SPEC.md          # This file — canonical definition
├── README.md                # Project overview
├── OUTREACH_PLAN.md         # Go-to-market strategy
├── v0.2/
│   ├── homepage.html
│   ├── category.html
│   ├── mike.html
│   ├── profile-template.html
│   └── become-task-leader.html
└── docs/
    ├── WHATSAPP_CONSENT_TEMPLATES.md
    └── CONSENT_IMPLEMENTATION.md
```

---

## Related Documents

| Document | Purpose |
|----------|---------|
| `OUTREACH_PLAN.md` | Provider acquisition strategy |
| `WHATSAPP_CONSENT_TEMPLATES.md` | WhatsApp messaging templates |
| `CONSENT_IMPLEMENTATION.md` | Frontend consent flow implementation |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-03-09 | v1.0 — Canonical spec created from consolidated docs |
| 2026-03-09 | v1.1 — Added Provider Setup Page (Post-Approval) specification |

---

*This document is the single source of truth for TaskLeaders product definition.*

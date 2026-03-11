# TaskLeaders — MVP Working Brief

**Version:** 1.0
**Date:** March 10, 2026
**Status:** Current Working Source of Truth
**Supersedes:** `PRODUCT_SPEC.md` as the active MVP operating brief
**Role of `PRODUCT_SPEC.md`:** Historical baseline and original vision reference only

---

## Purpose of This Document

This document is the **current working source of truth** for the TaskLeaders MVP.

It reconciles the original vision captured in `PRODUCT_SPEC.md` with the more recent direction that has emerged through actual webpage design and MVP decisions.

`PRODUCT_SPEC.md` should still be kept, but only as the **original baseline**. It should not override newer decisions that better reflect the current MVP direction.

---

## Brand Standard

The correct and only approved brand spelling is:

# **TaskLeaders**

Do not use:

* Task Leaders
* Taskleaders
* taskleaders.com as the product name

---

## Product Definition

TaskLeaders is a hyper-local service discovery and connection product that helps customers find trusted local providers quickly and contact them directly with minimal friction.

The MVP is focused on:

* ranked discovery
* trust and credibility
* fast direct connection
* simple, practical UX

The MVP is **not** trying to be a full marketplace at this stage.

---

## Core Promise

TaskLeaders helps users:

* find local service providers faster
* compare providers using clear trust/value signals
* connect directly without unnecessary platform friction

---

## MVP Philosophy

These rules govern all MVP decisions:

1. **Simplicity over perfection**
2. **Speed over features**
3. **Launch over polish**
4. **Trust over noise**
5. **Credibility over fake activity**
6. **Direct connection over platform complexity**

Every feature should answer:

> **Does this help customers understand, trust, and connect with a provider faster?**

If not, it should be deferred.

---

## What the MVP Is

The current MVP is a lean front-end experience built around:

* a homepage
* category pages
* TaskLeader profile pages
* direct connection calls to action

The MVP should feel like a **useful local service tool**, not a bloated marketplace or overbuilt SaaS platform.

---

## What the MVP Is Not

The MVP does **not** need to include:

* customer accounts
* booking systems
* customer payment processing
* in-app chat
* advanced provider dashboards
* complex automated ranking engines
* real-time provider availability tracking
* decorative activity metrics that cannot be supported

These may become future features, but they are **not required to validate the MVP**.

---

## Core Customer Flow

```text
Homepage
  ↓
Choose Category
  ↓
View Ranked TaskLeaders
  ↓
Open TaskLeader Profile
  ↓
Connect
```

This is now the clearest current MVP flow.

---

## Core Provider Flow

At MVP stage, the provider-side flow remains lightweight:

```text
Submit Application
  ↓
Manual Review / Verification
  ↓
Admin Approval
  ↓
Provider Profile Prepared
  ↓
Visible in Category Rankings
```

Provider onboarding should remain practical and as manual as needed during early MVP validation.

---

## Contact Model

TaskLeaders facilitates introductions between customers and providers.

### Current Principle

The product should emphasize **direct connection**.

WhatsApp may remain the main operational contact mechanism, but the product language should be driven by the clearest user experience.

### Current UX Direction

Use a simple contact CTA such as:

* **Connect**
* **Connect Now**
* or another single approved contact phrase used consistently across the product

The exact final wording should be standardized, but the principle is:

> **Make it obvious and easy for a customer to contact the provider immediately.**

---

## Trust and Comparison Signals

The most useful current provider comparison fields are:

### 1. Response Time

A speed-oriented signal that helps communicate responsiveness.

### 2. Reliability

A trust signal that should be written in full as:

**Reliability**

Never abbreviate this to `Reliab.` in the product UI.

### 3. Price

A simple pricing cue such as hourly rate.

These three signals remain the most valuable comparison framework for the MVP.

### Important Rule

Only display trust/value signals in ways that are actually supportable.

Avoid fake precision, unsupported calculations, or operational claims the MVP cannot reliably back up.

---

## Category Visibility Rule

**Critical MVP Rule:** Categories should only appear on the Homepage when at least one approved and activated TaskLeader exists in that category.

### Why This Matters

* Empty categories damage trust
* Customers expect to find help when they click a category
* The "Real Estate / Property Manager" target market requires reliability
* Showing "0 TaskLeaders" undermines credibility

### Approved Category Set (Real Estate / Property Manager Target Market)

The MVP focuses on these 8 categories:

| # | ID (slug) | Display Name | Icon | Description |
|---|-----------|--------------|------|-------------|
| 1 | `handyman` | Handyman | 🔧 | General repairs, fixes, installations |
| 2 | `plumbing` | Plumbing | 🚿 | Leaks, fixtures, repairs |
| 3 | `electrical` | Electrical | ⚡ | Outlets, lighting, minor electrical work |
| 4 | `painting` | Painting | 🎨 | Touch-ups, full rooms, prep-for-listing |
| 5 | `cleaning` | Cleaning | 🧹 | Deep cleaning, move-in/move-out, prep-for-listing |
| 6 | `furniture-assembly` | Furniture Assembly | 📦 | Staging, setup, installation |
| 7 | `moving` | Moving Help | 🚚 | Furniture moving, staging support |
| 8 | `yard-work` | Yard Work | 🌿 | Curb appeal, basic landscaping, cleanup |

**Standardization Rules:**
- **ID format:** kebab-case lowercase (e.g., `furniture-assembly`, `yard-work`)
- **Display format:** Title Case full names (e.g., `Furniture Assembly`, `Moving Help`)
- **Consistency required:** Same ID and display name across all pages, URLs, databases, and APIs

These categories align with the prep-for-listing work most commonly needed by real estate agents and property managers.

### Implementation

**Current MVP (Static):**
* Category list defined in frontend code (8 categories above)
* Filter to only show categories with `count > 0`
* If no categories have providers, show "coming soon" message instead of empty grid
* JavaScript filter applied before rendering category tiles

**Future Implementation:**
* Backend query: `SELECT DISTINCT category FROM providers WHERE status = 'approved' AND is_active = true`
* API endpoint returns only populated categories from the approved set
* Category pages 404 or redirect if accessed directly with no active providers

---

## Category Page Role

The category page is now one of the most important MVP screens.

Its purpose is to:

* establish the category and local area clearly
* present ranked TaskLeaders in a simple, trusted format
* help users compare options quickly
* guide users into the TaskLeader profile page
* move users toward direct connection

### Current Category Page Direction

A category page should emphasize:

* clarity
* trust
* ranking structure
* strong branded language
* clean layout

### Current Category Page Rules

Use:

* **TaskLeaders** instead of generic terms like **Providers** where appropriate
* **Reliability** in full
* simple, understandable comparison cues

Avoid:

* unsupported real-time activity indicators
* fake availability numbers
* UI clutter added just to fill space
* generic marketplace language that weakens the brand

### Example of What to Avoid

Do not show labels like:

* `12 available`
* `5 providers available now`

unless there is a real system supporting that claim.

If the data cannot be tracked reliably at launch, it should not be shown.

---

## TaskLeader Profile Page Role

The TaskLeader profile page is the key trust-and-conversion page in the MVP.

Its purpose is to help a customer understand:

* who the provider is
* what they offer
* why they are credible
* whether they feel like the right fit
* how to contact them immediately

### Profile Page Principle

The profile page should turn ranking interest into contact action.

It should be clearer, deeper, and more trust-building than the category page, without becoming bloated.

---

## Homepage Role

The homepage should guide users into the category-based experience as quickly as possible.

Its MVP role is to:

* introduce the TaskLeaders concept clearly
* help users choose a category
* reinforce the trust-first positioning
* create a direct path into category pages
* support provider onboarding where needed

A search bar may be included only if it genuinely improves usability. It is not more important than a clear category-led journey.

---

## Ranking Approach

TaskLeaders should present providers in a ranked or leaderboard-style format.

However, the MVP does **not** need to depend on a complex hidden scoring engine.

### Current Rule

The ranking should be:

* understandable
* credible
* consistent
* simple enough to support in MVP

If ranking is curated, manual, or lightly structured during MVP, that is acceptable.

Do not force advanced composite scoring systems into the MVP unless they are truly necessary and supportable.

---

## Provider Data Needed for MVP

At minimum, provider listings/profiles should support:

* provider or business name
* service category
* service area
* pricing cue
* short description
* trust/value signals used in ranking
* direct connection method

Anything beyond this should be justified by MVP usefulness.

---

## Admin Model

A lightweight admin model remains appropriate.

The MVP only needs enough admin capability to:

* review applications
* approve or reject providers
* edit provider information
* remove providers if needed

### Provider Status Fields

**status:** `pending` | `approved` | `rejected` | `suspended`
- Controlled by admin during application review
- Only `approved` providers can appear on the platform

**is_active:** `true` | `false`
- Controlled by approved providers (or admin)
- Allows providers to temporarily hide their profile without losing approved status
- Both `status = approved` AND `is_active = true` required for public visibility

### Category Visibility Dependency

The Homepage category list depends on this query:
```
SELECT DISTINCT category 
FROM providers 
WHERE status = 'approved' 
  AND is_active = true
```

The admin system should remain minimal until the MVP proves traction.

---

## UI and Content Rules

### Use

* TaskLeaders
* Reliability
* clean utility-first layouts
* direct contact language
* simple trust-building copy

### Avoid

* fake activity indicators
* unsupported live metrics
* filler UI elements
* unnecessary dashboards
* over-designed SaaS patterns
* generic wording when branded wording is stronger

---

## Language Standards

### Approved Terms

* **TaskLeaders**
* **Reliability**
* **Connect** / **Connect Now** (pending final CTA standardization)
* **TaskLeader Profile**

### Terms to Deprioritize or Replace

* **Providers** as the main branded label
* abbreviated labels like **Reliab.**
* unsupported phrases like **available now**

---

## Current MVP Success Test

The MVP is successful if a user can:

* understand what TaskLeaders is
* browse a category easily
* compare TaskLeaders without confusion
* trust the page enough to make a selection
* click into a profile confidently
* connect with a provider quickly

That is the current test the product must pass.

---

## Current Priorities

### 1. Lock the Category Page

Finalize the current category-page layout, structure, and copy so it becomes the template for additional categories.

### 2. Build the TaskLeader Profile Page

This is the next key screen in the user journey and the main trust-to-conversion page.

### 3. Standardize Trust Signals

Decide exactly which comparison fields are truly supportable in MVP and use them consistently.

### 4. Standardize CTA Language

Choose one primary connection label and use it consistently across the product.

### 5. Remove Unsupported Assumptions

Explicitly defer live availability indicators, advanced scoring formulas, and other systems the MVP cannot yet support credibly.

### 6. Use This Brief as the Active Reference

Going forward, this document should guide MVP decisions ahead of the original `PRODUCT_SPEC.md`.

---

## Relationship to PRODUCT_SPEC.md

`PRODUCT_SPEC.md` remains valuable as:

* the original baseline vision
* a record of early product assumptions
* a strategic reference

But it should **not** override newer MVP decisions when those decisions better reflect:

* actual page design work
* current launch priorities
* realistic functionality
* cleaner UX direction

---

## Working Rule Going Forward

Use the following hierarchy:

1. **Current MVP Working Brief** → active source of truth
2. **Actual approved page decisions** → immediate implementation guide
3. **PRODUCT_SPEC.md** → baseline reference only

---

## Summary

TaskLeaders is currently best understood as a **trust-first local service discovery and connection MVP**.

The product should stay focused on:

* category-led browsing
* ranked TaskLeader presentation
* strong trust cues
* simple branded UX
* direct connection

Anything that adds complexity without improving trust or connection speed should be deferred.

---

*End of current MVP working brief.*

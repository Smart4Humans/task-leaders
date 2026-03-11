# TaskLeader Profile Page — HTML to MVP Spec Comparison

> **Source Files:** mike.html, profile-template.html  
> **Target Spec:** TASKLEADER_PROFILE_PAGE_SPEC.md (v2.0)  
> **Date:** March 10, 2026

---

## Executive Summary

Both HTML files predate the finalized MVP spec and contain **significant deviations** from the current trust-first, lean approach. The templates include marketplace features (reviews, job counts, ratings) and fake activity signals that are explicitly excluded from MVP.

---

## Detailed Comparison Matrix

### 1. HERO SECTION

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Photo** — Full-width, face-visible | ✅ 90px circular avatar | Keep, but consider larger/full-width |
| **Name** — H1, first + last | ✅ `.name` div | Keep |
| **Category Badge** — Service category | ❌ Missing | **ADD** |
| **Location** — Neighborhood + City | ❌ Missing | **ADD** |
| **Badges** — "SPEEDSTER", "PRO" | ⚠️ Present | **REMOVE** — not in MVP spec |
| **Online status** — "🟢 Online now" | ⚠️ Present | **REMOVE** — fake activity signal |

**Changes Needed:**
- Remove `.badges` container with SPEEDSTER/PRO labels
- Remove `.status-online` element
- Add category badge (e.g., "House Cleaning")
- Add location (e.g., "Kitsilano, Vancouver")

---

### 2. TRUST BAR (ABOVE FOLD)

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **"Responds in"** label | ❌ "Response" | **RENAME** |
| **Response time value** | ✅ "1.2m" / "{{RESPONSE_TIME}}" | Keep, but format as "2 hours" not "1.2m" |
| **"Reliability"** — full word | ❌ Missing | **ADD** |
| **"From"** price label | ❌ "$45-55/hr" in services | **RESTRUCTURE** — move to trust bar |
| **Horizontal layout** | ❌ 3-column grid | **RESTRUCTURE** — horizontal trust bar |

**Current Stats Section:**
```html
<div class="stats">
  <div class="stat">
    <div class="stat-value">1.2m</div>  <!-- RENAME label to "Responds in" -->
    <div class="stat-label">Response</div>  <!-- CHANGE to "Responds in" -->
  </div>
  <div class="stat">
    <div class="stat-value">4.9★</div>  <!-- REMOVE — star ratings excluded -->
    <div class="stat-label">156 Reviews</div>  <!-- REMOVE — reviews excluded -->
  </div>
  <div class="stat">
    <div class="stat-value">202</div>  <!-- REMOVE — job stats excluded -->
    <div class="stat-label">Jobs</div>  <!-- REMOVE -->
  </div>
</div>
```

**Required Trust Bar:**
```html
<div class="trust-bar">
  <div class="trust-item">
    <span class="trust-label">Responds in</span>
    <span class="trust-value">2 hours</span>
  </div>
  <div class="trust-item">
    <span class="trust-badge">✓</span>
    <span class="trust-label">Reliability</span>
  </div>
  <div class="trust-item">
    <span class="trust-label">From</span>
    <span class="trust-value">$45/hour</span>
  </div>
</div>
```

---

### 3. SERVICE CATEGORIES SECTION

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Single primary category** | ❌ Multiple categories | **DECISION NEEDED** — spec implies single, template shows many |
| **Price display** | ✅ "$45-55/hr" | Keep, but move to trust bar |
| **Ranking display** — "#1 in Painting" | ⚠️ Present | **REMOVE** — unsupported ranking claims |
| **Job counts** — "156 jobs" | ⚠️ Present | **REMOVE** — unsupported stats |

**Changes Needed:**
- Remove "#X in Category" ranking text
- Remove job count stats
- Consider simplifying to single category for MVP
- Move price to trust bar

---

### 4. ABOUT SECTION

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Headline** — "About [Name]" | ✅ "📝 About" | **RENAME** — include name |
| **2-3 sentences max** | ⚠️ Present | Keep, enforce limit |
| **Experience indicator** | ❌ Missing | **ADD** — "8 years experience" |
| **"Read more" link** | ⚠️ Present | **REMOVE** — keep content short, no expansion |

**Changes Needed:**
- Change "📝 About" to "About Mike"
- Add experience line
- Remove "Read more" link

---

### 5. SERVICE AREA SECTION

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **"Service Area" headline** | ❌ Missing entirely | **ADD** |
| **Neighborhood list** | ❌ Missing | **ADD** |
| **Optional static map** | ❌ Missing | Optional for MVP |

**Changes Needed:**
- Add new section after About
- Include neighborhoods served

---

### 6. REVIEWS SECTION

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Reviews** | ⚠️ Full section present | **REMOVE ENTIRE SECTION** |
| **Star ratings** | ⚠️ "★★★★★" | Remove |
| **"View all X reviews"** | ⚠️ Present | Remove |

**Spec Exclusion:**
> "Reviews section — Trust-first, not rating-first"

**Action:** Delete `.reviews-preview` section entirely.

---

### 7. CTA PLACEMENT

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Primary CTA above fold** | ✅ `.top-cta` button | Keep |
| **Button text: "Connect"** | ❌ "💬 Message Mike Now" | **RENAME** — use "Connect" |
| **Sticky header with CTA** | ❌ Missing | **ADD** — appears on scroll |
| **Sticky bottom CTA** | ✅ `.sticky-cta` | Keep |
| **Subtext under CTA** | ⚠️ "Typically responds..." | Keep, but ensure consistent |

**Changes Needed:**
- Change button text from "Message Mike Now" to "Connect"
- Add sticky header that appears after scrolling (name + Connect button)
- Standardize subtext format

---

### 8. MODAL / CONNECTION FLOW

| Spec Requirement | Current HTML | Action |
|------------------|--------------|--------|
| **Simple direct connection** | ❌ Complex 2-step modal | **SIMPLIFY** — spec implies direct WhatsApp |
| **Phone verification** | ⚠️ 6-digit code step | **DECISION NEEDED** — adds friction |
| **Consent checkboxes** | ⚠️ Present | Keep for compliance |
| **Name input** | ✅ Present | Keep (optional) |

**Spec Says:**
> "Direct connection" — "One clear CTA, no intermediate steps"

**Question:** Does the verification step align with "minimal friction"? Consider:
- Option A: Keep verification (security/compliance)
- Option B: Direct WhatsApp link (true minimal friction)

---

## Summary: Keep, Remove, Rename, Add

### KEEP ✅
- Overall page structure (header, main, sections)
- Avatar/photo display
- Name display
- About section concept
- Sticky bottom CTA concept
- Modal connection flow (pending decision)
- Consent checkboxes (compliance)
- Mobile-first responsive design

### REMOVE ❌
| Element | Location | Reason |
|---------|----------|--------|
| Badges (SPEEDSTER, PRO) | `.badges` | Not in MVP spec |
| Online status indicator | `.status-online` | Fake activity signal |
| Star ratings | `.stat-value` 4.9★ | Reviews excluded |
| Review count | `.stat-label` "156 Reviews" | Reviews excluded |
| Job count stats | `.stat-value` "202" | Unsupported claims |
| Ranking claims | `.service-rank` "#1 in..." | Unsupported |
| Reviews section | `.reviews-preview` | Reviews excluded |
| "Read more" link | `.read-more` | Keep content short |
| Multiple service categories | `.service-category` (3+) | Simplify to single category? |

### RENAME 📝
| Current | New | Location |
|---------|-----|----------|
| "Response" | "Responds in" | Trust bar label |
| "📝 About" | "About [Name]" | Section headline |
| "Message Mike Now" | "Connect" | CTA button |
| "Message Mike on WhatsApp" | "Connect" | Sticky CTA button |

### ADD ➕
| Element | Location | Priority |
|---------|----------|----------|
| Category badge | Hero section | High |
| Location (neighborhood/city) | Hero section | High |
| Trust bar restructure | Replace stats | High |
| "Reliability" badge | Trust bar | High |
| "From" price | Trust bar | High |
| Experience indicator | About section | Medium |
| Service Area section | After About | Medium |
| Sticky header | Top of page (scroll) | Medium |
| Single category focus | Replace multi-category | Decision needed |

---

## Recommended Priority Order

### Phase 1: Critical (Blocks MVP Alignment)
1. Remove reviews section entirely
2. Remove fake activity signals (online status, badges)
3. Remove unsupported stats (job counts, rankings)
4. Restructure stats → trust bar with correct labels
5. Rename CTAs to "Connect"

### Phase 2: Important (Trust & Clarity)
6. Add category badge and location to hero
7. Add Service Area section
8. Add experience to About
9. Add sticky header behavior

### Phase 3: Polish
10. Simplify to single category (if decided)
11. Review modal flow for friction
12. Optimize photo size and layout

---

## Files to Update

1. **profile-template.html** — Primary template
2. **mike.html** — Example instance (update to match template)

---

*End of comparison analysis.*

# Public TaskLeader Profile Page — Definition

> **Sources:** TASKLEADERS_MVP_WORKING_BRIEF.md + TASKLEADER_PROFILE_PAGE_SPEC.md  
> **Audience:** Public-facing customer view  
> **Date:** March 10, 2026

---

## 1. Final Section Order

```
┌─────────────────────────────────────┐
│  STICKY HEADER (appears on scroll)  │  ← Name + Connect button
├─────────────────────────────────────┤
│                                     │
│  HERO SECTION                       │  ← Photo, Name, Category, Location
│  (Above the Fold)                   │
│                                     │
├─────────────────────────────────────┤
│  TRUST BAR                          │  ← Responds in | Reliability | From
│  (Above the Fold)                   │
├─────────────────────────────────────┤
│  PRIMARY CTA                        │  ← "Connect" button
│  (Above the Fold)                   │
├─────────────────────────────────────┤
│                                     │
│  SERVICES SECTION                   │  ← All categories with per-service pricing
│  (Below Fold)                       │     + Pricing note
│                                     │
├─────────────────────────────────────┤
│  ABOUT SECTION                      │  ← Expanded description, experience
│  (Below Fold)                       │
├─────────────────────────────────────┤
│  SERVICE AREA SECTION               │  ← All neighborhoods served
│  (Below Fold)                       │
├─────────────────────────────────────┤
│  SECONDARY CTA                      │  ← "Connect" reinforcement
│  (Below Fold)                       │
├─────────────────────────────────────┤
│  STICKY BOTTOM CTA                  │  ← Persistent Connect button
│  (Fixed to viewport)                │
└─────────────────────────────────────┘
```

---

## 2. Exact Content Blocks

### HERO SECTION
| Element | Content | Source (Profile Setup) |
|---------|---------|------------------------|
| Photo | Profile image OR business logo | `profile_image` or `business_logo` |
| Name | Full name or business name | `display_name` |
| Category Badge | Primary service category | `primary_category` |
| Location | Base neighborhood + City | `base_location` |

### TRUST BAR (Horizontal, 3 items)
| Element | Label | Value | Source |
|---------|-------|-------|--------|
| Response Time | "Responds in" | "2 hours" / "Same day" | `response_time` (self-reported) |
| Reliability | "Reliability" | ✓ Badge | `reliability_verified` (admin) |
| Price | "From" | "$45/hour" | `base_rate` (lowest category rate) |

### PRIMARY CTA
- **Button:** "Connect"
- **Subtext:** "Direct message via WhatsApp"
- **Action:** Open connection modal

### SERVICES SECTION
| Element | Content | Source |
|---------|---------|--------|
| Headline | "Services & Rates" | — |
| Service List | All categories with individual rates | `services[]` (array) |
| Pricing Note | Listed rates are a general guide... | Static text |

**Pricing Note Text:**
> "Listed rates are a general guide. Final pricing may vary based on the details of your job, materials required, location, and timing."

### ABOUT SECTION
| Element | Content | Source |
|---------|---------|--------|
| Headline | "About [Name]" | — |
| Description | Expanded intro/bio (up to 200 words) | `bio` |
| Experience | "X years experience" | `years_experience` |
| Credentials | Verified certifications (optional) | `credentials` |

### SERVICE AREA SECTION
| Element | Content | Source |
|---------|---------|--------|
| Headline | "Service Area" | — |
| Areas | List of all neighborhoods served | `service_areas[]` (array) |

### SECONDARY CTA
- **Button:** "Connect with [Name]"
- **Context:** After reading full profile

### STICKY BOTTOM CTA
- **Button:** "Connect"
- **Subtext:** "Usually responds in [X]"
- **Behavior:** Fixed to bottom of viewport

---

## 3. Above the Fold (Mobile Viewport 1)

Must be visible without scrolling:

1. ✅ Profile/business photo
2. ✅ Name
3. ✅ Primary category badge
4. ✅ Base location
5. ✅ Trust bar (all 3 signals)
6. ✅ "Connect" button

**Target:** User can understand who this is and connect in < 5 seconds.

---

## 4. Primary CTA Placement

| Location | Timing | Purpose |
|----------|--------|---------|
| **Hero CTA** | Immediate | Capture ready users |
| **Sticky Header** | After scroll | Persistent access |
| **Secondary CTA** | After content | Capture readers |
| **Sticky Bottom** | Always visible | Never lose the path |

**Minimum:** 2 touchpoints (Hero + Sticky Bottom)
**Optimal:** 4 touchpoints as listed

---

## 5. Pricing Note Placement

**Location:** Within Services section, after the service list

**Format:**
```
[Service 1: $45/hr]
[Service 2: $50/hr]
[Service 3: $40/hr]

💡 Listed rates are a general guide. Final pricing may vary 
based on the details of your job, materials required, location, 
and timing.
```

**Visual treatment:** Subtle, helpful, not alarming

---

## 6. Mobile-First Priorities

### Thumb Zone (Easy Reach)
- Primary Connect button
- Trust bar (scanning)

### Top Zone (Hard Reach)
- Back button only
- No critical actions

### Scroll Flow
1. See photo + name (immediate recognition)
2. Scan trust bar (credibility check)
3. Tap Connect (conversion) OR scroll for more
4. Services (detailed offering)
5. About (trust building)
6. Service Area (local relevance)
7. Connect (final CTA)

---

## 7. Excluded Elements (Per Working Brief)

| Excluded | Reason |
|----------|--------|
| Heavy public review system | Trust-first, not rating-first |
| Star ratings | Fake precision |
| "Online now" status | Unsupported real-time data |
| Job completion counts | Unsupported claims |
| Ranking badges ("#1 in...") | Unsupported |
| Availability calendar | Complex, unproven |
| Skills/tags cloud | Clutter |
| Social media links | Distracts from conversion |
| Photo gallery | Single strong photo suffices |
| "Save/Favorite" | Requires accounts |

---

## 8. Trust Signals (Included)

| Signal | Type | Source |
|--------|------|--------|
| Reliability badge | Admin-verified | Profile setup → admin approval |
| Response time | Self-reported | Profile setup |
| Years experience | Self-reported | Profile setup |
| Credentials | Verified optional | Profile setup + admin check |
| Professional photo | Visual trust | Profile setup |

---

## 9. Profile Setup Alignment

All public-facing content should be capturable during provider onboarding:

| Public Element | Profile Setup Field |
|----------------|---------------------|
| Photo | `profile_image` |
| Name | `display_name` |
| Category | `primary_category` + `services[].category` |
| Location | `base_location` |
| Service Areas | `service_areas[]` |
| Rates | `services[].rate` |
| Response Time | `response_time` |
| Bio | `bio` |
| Experience | `years_experience` |
| Credentials | `credentials[]` |
| Reliability | Admin-set after verification |

---

*End of definition.*

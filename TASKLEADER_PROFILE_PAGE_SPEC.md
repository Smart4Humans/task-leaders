# TaskLeader Profile Page — MVP Concrete Specification

> **Governing Source of Truth:** TASKLEADERS_MVP_WORKING_BRIEF.md  
> **Version:** 2.0 (Concrete MVP)  
> **Date:** March 10, 2026  
> **Status:** Ready for Implementation

---

## Purpose

Turn ranking interest into contact action. This is the **trust-and-conversion page** in the TaskLeaders MVP flow.

---

## Final Section Order (Top to Bottom)

### 1. Sticky Header (Mobile)
- **Content:** TaskLeader name + "Connect" button
- **Behavior:** Appears after scrolling past hero
- **Purpose:** Persistent conversion path

### 2. Hero Section (Above the Fold)
| Element | Specification |
|---------|---------------|
| **Photo** | Full-width, face-visible, professional but personal |
| **Name** | H1, first + last (or business name) |
| **Category Badge** | Service category (e.g., "House Cleaning") |
| **Location** | Neighborhood + City (e.g., "Kitsilano, Vancouver") |

### 3. Trust Bar (Above the Fold)
| Element | Field Label | Format |
|---------|-------------|--------|
| **Response Time** | "Responds in" | "X hours" or "Same day" |
| **Reliability** | "Reliability" | Badge/icon + label (never "Reliab.") |
| **Price** | "From" | "$X/hour" or "Starting at $X" |

**Layout:** Horizontal row, evenly spaced, icon + label + value

### 4. About Section (Below Fold)
| Element | Specification |
|---------|---------------|
| **Headline** | "About [Name]" |
| **Description** | 2-3 sentences max, first person or professional bio |
| **Experience** | "X years experience" or "X+ clients served" |
| **Credentials** | Optional: certifications, licenses (only if verified) |

### 5. Service Area Section (Below Fold)
| Element | Specification |
|---------|---------------|
| **Headline** | "Service Area" |
| **Location** | Neighborhood focus (e.g., "Kitsilano, Fairview, Mount Pleasant") |
| **Map** | Optional MVP: simple static map or text list |

### 6. Primary CTA Section (Below Fold + Sticky)
| Element | Specification |
|---------|---------------|
| **Button Text** | **"Connect"** |
| **Subtext** | "Direct message via WhatsApp" or similar |
| **Placement** | After Service Area + sticky header fallback |

### 7. Footer (Optional MVP)
- Simple link back to category page
- TaskLeaders branding

---

## Mobile-First Layout Priorities

### Viewport 1 (First Screen)
1. Photo (60% of viewport height max)
2. Name + Category + Location
3. Trust Bar (all three signals)
4. "Connect" button (primary, full-width)

### Viewport 2+ (Scroll)
1. About section
2. Service Area
3. Secondary CTA reinforcement

### Thumb Zone Priority
- Primary "Connect" button: bottom 25% of first viewport
- Trust Bar: middle, easily scannable
- No critical actions in top 10% (hard to reach)

---

## Recommended Field Labels

| Use This | Never This |
|----------|------------|
| "Responds in" | "Response Time" (too formal) |
| "Reliability" | "Reliab." (never abbreviate) |
| "From" | "Price" (implies fixed) |
| "Connect" | "Contact" (weaker) / "Book" (unsupported) |
| "Service Area" | "Coverage" (impersonal) |
| "About [Name]" | "Bio" (too casual) |

---

## CTA Placement Strategy

| Location | Purpose |
|----------|---------|
| **Primary (hero)** | Immediate conversion for ready users |
| **Sticky header** | Persistent access after scrolling |
| **Bottom of page** | Reinforcement for readers who scroll |

**Rule:** Minimum two touchpoints. Never hide the connect path.

---

## Above the Fold Requirements

Must be visible without scrolling on mobile:

- [ ] TaskLeader photo
- [ ] Name
- [ ] Category
- [ ] Location
- [ ] All three trust signals (Response, Reliability, Price)
- [ ] Primary "Connect" button

**Target:** User can understand and convert in 5 seconds, zero scrolling.

---

## MVP Exclusions (What to Remove)

| Excluded Element | Why |
|------------------|-----|
| Photo gallery | Single strong photo > multiple mediocre |
| Heavy public review system | No complex ratings, review counts, or public review feeds |
| Star ratings | Fake precision, unverified |
| "Last active" timestamp | Unsupported real-time data |
| Availability calendar | Complex, unproven need |
| Skills/tags list | Clutter, not decision-critical |
| Social media links | Distracts from conversion |
| "Save" or "Favorite" | Requires accounts, MVP scope |
| Share buttons | Low priority, adds noise |
| Provider stats ("127 jobs completed") | Unsupported claims |
| In-app chat | Platform friction, out of scope |
| Booking form | Out of MVP scope |

## Trust Signals (What to Keep)

Per TASKLEADERS_MVP_WORKING_BRIEF.md, simple trust signals are valuable when credible and supportable:

| Signal | Type | Display |
|--------|------|---------|
| **Reliability** | Admin-verified badge | Checkmark + "Reliability" label |
| **Response Time** | Provider self-reported | "Responds in X hours" |
| **Price** | Provider rate | "From $X/hour" |
| **Experience** | Provider stated | "X years experience" (optional) |
| **Credentials** | Verified only | Certifications, licenses (optional) |

**Principle:** Trust-first means showing credible signals that help users decide, not hiding all social proof. Avoid unverified claims, fake metrics, or complex systems the MVP cannot support.

---

## Content Block Specifications

### Photo Requirements
- Face clearly visible
- Professional but approachable
- Local context if possible (neighborhood backdrop)
- Square or 4:5 aspect ratio
- Minimum 400x400px

### Name Format
- Individual: "[First] [Last]"
- Business: "[Business Name]"
- Never: usernames, handles, or incomplete names

### Trust Bar Values
| Signal | Source | Display |
|--------|--------|---------|
| Responds in | Provider self-reported | "2 hours", "Same day", "24 hours" |
| Reliability | Admin-verified badge | Checkmark + "Reliability" |
| From | Provider rate | "$45/hour", "Starting at $50" |

### About Text
- Maximum 150 words
- First person ("I specialize in...") OR professional third person
- Focus on expertise and approach
- No marketing fluff

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to understand | < 5 seconds |
| Time to connect CTA | < 3 seconds (above fold) |
| Scroll depth to convert | Optional (CTA above fold) |
| Bounce rate | < 40% |
| Connect click-through | > 15% |

---

## Implementation Checklist

- [ ] Mobile viewport tested (375px width)
- [ ] All content above fold on small screens
- [ ] Sticky header appears on scroll
- [ ] "Connect" button functional (WhatsApp deep link)
- [ ] Trust signals populated from real data
- [ ] Photo optimized (< 100KB)
- [ ] Page load < 2 seconds
- [ ] No excluded elements present
- [ ] Simple trust signals present (Reliability, Response Time, Price)

---

*End of concrete specification.*

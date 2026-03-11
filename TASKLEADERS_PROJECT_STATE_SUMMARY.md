# TaskLeaders — Project State Summary

**Date:** March 11, 2026  
**Status:** MVP Development  
**Target Market:** Real Estate / Property Managers (Vancouver)

---

## 1. Source-of-Truth Hierarchy

| Priority | Document | Purpose |
|----------|----------|---------|
| 1 | `TASKLEADERS_MVP_WORKING_BRIEF.md` | Active MVP decisions |
| 2 | `TASKLEADERS_SITE_FUNCTIONALITY_RULES.md` | Coding reference |
| 3 | `CATEGORY_STANDARDS.md` | Category definitions |
| 4 | `PRODUCT_SPEC.md` | Historical baseline only |

---

## 2. Page Inventory & Roles

| Page | File | Role | Status |
|------|------|------|--------|
| Homepage | `v0.2/homepage.html` | Entry, category selection, recruitment | Ready |
| Category Page | `v0.2/category.html` | Ranked TaskLeader listings | Template ready |
| TaskLeader Public Profile | `v0.2/profile.html` | Trust, conversion, Connect CTA | Template ready |
| Become a TaskLeader | `v0.2/become-task-leader.html` | Provider application | Ready |
| TaskLeader Profile Setup | `v0.2/taskleader-profile-setup.html` | Post-approval onboarding/editing | Local |
| TaskLeader Sign In | `v0.2/taskleader-signin.html` | Returning provider auth | Local |
| Admin | `v0.2/admin.html` | Provider management | Local |

---

## 3. Approved Category Set

**Target:** Real Estate / Property Manager prep-for-listing work

| ID | Display Name | Icon |
|----|--------------|------|
| `handyman` | Handyman | 🔧 |
| `plumbing` | Plumbing | 🚿 |
| `electrical` | Electrical | ⚡ |
| `painting` | Painting | 🎨 |
| `cleaning` | Cleaning | 🧹 |
| `furniture-assembly` | Furniture Assembly | 📦 |
| `moving` | Moving Help | 🚚 |
| `yard-work` | Yard Work | 🌿 |

**Rule:** Categories only display when ≥1 approved, active TaskLeader exists.

---

## 4. Customer Flow

```
Homepage → Category Page → TaskLeader Public Profile → Connect → WhatsApp
```

**Key Rules:**
- Categories filtered by supply
- Public profiles from approved Profile Setup data only
- WhatsApp = external handoff (no platform messaging)

---

## 5. TaskLeader Flow

**Recruitment:**
```
Homepage/Outreach → Become a TaskLeader → Application → Founder Call → Approval → Profile Setup
```

**Returning:**
```
TaskLeader Sign In → Magic Link → Profile Setup (edit mode)
```

**Key Rules:**
- Profile Setup is post-approval only
- Sign In restricted to approved TaskLeaders
- Same page for onboarding and editing

---

## 6. Core Rules

### Homepage
- Links: Categories, Become a TaskLeader (primary), TaskLeader Sign In (secondary)
- Categories display only with approved supply
- 8 approved categories (RE/PM target market)

### Category Page
- Ranked TaskLeader listings
- Filter/sort by Response, Reliability, Price
- Links to TaskLeader Public Profile

### TaskLeader Public Profile
- Data source: TaskLeader Profile Setup only
- Location: Primary city + service areas
- Trust signals: Response (min), Reliability (%), Price ($/hr)
- Connect CTA → WhatsApp

### TaskLeader Profile Setup
- Post-approval access only (magic link)
- Not publicly navigable
- Used for onboarding and editing

### TaskLeader Sign In
- Passwordless (email magic link)
- Approved TaskLeaders only

---

## 7. Live vs Local

### Live on GitHub Pages
| File | URL |
|------|-----|
| v0.2/homepage.html | /v0.2/homepage.html |
| v0.2/become-task-leader.html | /v0.2/become-task-leader.html |
| v0.2/category.html | /v0.2/category.html |
| v0.2/profile.html | /v0.2/profile.html |
| Flow maps | /TASKLEADERS_FLOW_MAP.html |

### Local Only (not pushed)
- v0.2/taskleader-profile-setup.html
- v0.2/taskleader-signin.html
- v0.2/admin.html
- v0.3/* (older version)
- v0.4/* (experimental, incomplete)

**Note:** v0.2 is the current MVP track.

---

## 8. Top Priorities

1. **Finalize TaskLeader Profile Setup page**
   - Form fields, validation, save logic
   - Photo upload, service selection, pricing

2. **Finalize TaskLeader Sign In page**
   - Email input, magic link flow
   - Authentication state handling

3. **Connect Category Page to real data**
   - Dynamic ranking from approved providers
   - Filter/sort functionality

4. **Populate TaskLeader Public Profile from Profile Setup**
   - Data binding, trust signal calculation
   - WhatsApp CTA integration

5. **Admin workflow for approval**
   - Review applications, set status
   - Send magic links to approved providers

---

## 9. Explicitly Deferred

| Item | Reason |
|------|--------|
| Customer accounts | Not needed for MVP (browse → WhatsApp) |
| In-app messaging | WhatsApp is the platform |
| Platform payments | Direct provider negotiation |
| Real-time availability | Cannot support reliably at MVP |
| Booking/calendar | Post-MVP feature |
| Provider mobile app | Web-first MVP |
| Automated ranking engine | Manual/curated ranking at MVP |
| Customer reviews | Post-launch feature |
| Multi-city expansion | Vancouver-only launch |
| HVAC category | Not core to RE/PM prep-for-listing |

---

## Quick Restart

1. Read `TASKLEADERS_MVP_WORKING_BRIEF.md`
2. Check `TASKLEADERS_SITE_FUNCTIONALITY_RULES.md` for coding rules
3. Reference `CATEGORY_STANDARDS.md` for category data
4. Work in `v0.2/` directory
5. Push to deploy to GitHub Pages

---

## Last Updated

March 11, 2026
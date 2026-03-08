# Task Leaders v0.2 — Customer Testing Summary

**Date:** March 7, 2026  
**Tester:** Mike (real estate agent, target customer)  
**Goal:** Validate customer experience from browse to contact

---

## Live Demo URLs

| Page | URL | Purpose |
|------|-----|---------|
| **Homepage** | https://smart4humans.github.io/task-leaders/v0.2/homepage.html | Entry point — category selection |
| **Category (Painting)** | https://smart4humans.github.io/task-leaders/v0.2/category.html | Leaderboard with filters |
| **Profile (Mike)** | https://smart4humans.github.io/task-leaders/v0.2/profile-multi-category.html | Provider details + WhatsApp |
| **Customer Signup** | https://smart4humans.github.io/task-leaders/v0.2/customer-signup.html | Account creation flow |

---

## The Customer Flow

```
1. HOMEPAGE
   "What do you need help with?"
   → Click [🎨 Painting]
   
2. CATEGORY PAGE
   "Painting — 1,247 Taskers"
   [Filters: Overall | Online | Fastest | Top Rated | Best Price]
   → See ranked list
   → Click "Mike's Services"
   
3. PROFILE PAGE
   - Avatar, badges (⚡ SPEEDSTER 💎 PRO)
   - Stats: 1.2m response, 4.9★, 8yr experience
   - Services & rates by category:
     * Handyman: $55/hr (#2 rank)
     * Plumbing: $75/hr (#1 rank)
     * Painting: $45/hr (#3 rank)
   - [💬 Message Mike on WhatsApp]
   
4. WHATSAPP
   - Pre-filled message opens
   - Customer chats directly with provider
   - Platform tracks: inquiry sent, response time
```

---

## Key Questions for Mike

### Discovery
- [ ] Can you find a painter without instructions?
- [ ] Do the category tiles make sense?
- [ ] Is "1,247 Taskers" credible or overwhelming?

### Leaderboard
- [ ] Do you understand the ranking?
- [ ] Would you use the filters (Online Now, Fastest, etc.)?
- [ ] Is price visible enough?
- [ ] Do badges (SPEEDSTER, PRO) matter to you?

### Profile
- [ ] Do you trust Mike based on this page?
- [ ] Are rates by category clear?
- [ ] Would you click the WhatsApp button?
- [ ] Any hesitation before contacting?

### Overall
- [ ] Would you use this to find a handyman/plumber/etc?
- [ ] What's missing that would make you more likely to use it?
- [ ] Would you sign up (email + phone verify) to contact providers?

---

## Business Model (Behind the Scenes)

**Customers:** Free to browse and contact
**Providers:** 
- 5 free leads (no credit card)
- Then $19/mo founding rate (vs $29 regular)
- 100% of job revenue kept by provider

**Metrics tracked:**
- Response time (from inquiry to provider reply)
- Completion rate (did customer hire them?)
- On-time rate (did provider show up?)
- Rating (1-5 stars)

All metrics come from **customer feedback**, not provider self-reporting.

---

## What's NOT Built Yet

- Real WhatsApp integration (mock only)
- Provider dashboard
- Payment processing
- Review/rating system
- Search functionality
- Map/location view

---

## Next Steps After Mike's Feedback

1. **If positive:** Build provider onboarding flow
2. **If concerns:** Iterate on UX based on feedback
3. **Either way:** Start recruiting founding providers

---

## Files in This Version

```
v0.2/
├── homepage.html              # Category selection
├── category.html              # Leaderboard with filters
├── profile.html               # Single-category provider
├── profile-multi-category.html # Multi-category provider (Mike)
├── customer-signup.html       # 3-step signup with 2FA
├── provider-dashboard.html    # Read-only provider stats
├── become-tasker.html         # Provider application
└── COMMUNICATION_FLOW.md      # WhatsApp message templates
```

---

**Internal codename:** Task Leaders  
**Public branding:** Task Leaders (two words)  
**Domain:** TBD (TaskRank.com $1300 CAD — pending decision)

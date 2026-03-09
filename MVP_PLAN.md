# ⚠️ DEPRECATED — Merged into PRODUCT_SPEC.md

**This file has been consolidated into [PRODUCT_SPEC.md](PRODUCT_SPEC.md).**

Please refer to the product spec for the canonical definition.

---

# TaskLeaders.com — MVP Plan (Archive)

## The Big Idea
A live leaderboard marketplace where service providers compete on responsiveness, availability, and quality. Customers see who's actually ready to work *right now*.

**Tagline:** *"See who's available. Ranked by speed."*

---

## Domain Options (All Available ✓)

| Domain | Vibe | Recommendation |
|--------|------|----------------|
| **TaskLeaders.com** | Professional, clear | ⭐ Primary choice |
| TaskRank.com | Competitive, gamified | Backup |
| LeaderBoard.com | Generic, could expand beyond tasks | Future brand |
| FastTask.com | Speed-focused | Alternative |

**Recommendation:** TaskLeaders.com — clear, memorable, says exactly what it is.

---

## The "Leader" Tiers (Fun Names)

| Tier | Name | Requirements | Badge |
|------|------|--------------|-------|
| Entry | **Rookie** | New signup, < 5 jobs | 🌱 |
| Budget | **El Cheapo** | 20%+ below avg price, 4.0+ stars | 💰 |
| Speed | **Speedster** | < 10 min avg response | ⚡ |
| Reliable | **Rock Solid** | 95% on-time, 4.5+ stars | 🎯 |
| Elite | **Champion** | Top 10% in category | 🏆 |
| Legend | **OG** | 100+ jobs, 4.9+ stars, < 5 min response | 👑 |

**Special Badges:**
- **Night Owl** 🦉 — Available 6pm-6am
- **Weekend Warrior** 🏖️ — Works Saturdays/Sundays
- **Same-Day Samurai** ⚔️ — 90% same-day availability
- **Perfect Week** 🔥 — 7 days available in a row
- **Speed Demon** 💨 — < 2 min response time (24h streak)

### El Cheapo Tier Details

**The Hook:** *"Quality work, fair price"*

**Requirements:**
- Price must be 20%+ below category average
- Minimum 4.0 star rating (no garbage work allowed)
- Response time under 30 minutes
- At least 3 completed jobs

**Why It Works:**
- Turns "cheapest" into a badge of honor
- Customers can filter by budget without sacrificing quality
- Providers compete on efficiency, not just price
- Creates a "value tier" separate from the premium tiers

**Customer Filter:** *"Show me El Cheapos for painting this weekend"*

---

## Core Mechanics

### The Leaderboard Algorithm v1.0

```
LEADER_SCORE = (
  RESPONSE_TIME_SCORE × 0.30 +
  AVAILABILITY_SCORE × 0.25 +
  COMPLETION_RATE × 0.20 +
  CUSTOMER_RATING × 0.20 +
  ON_TIME_RATE × 0.05
)
```

| Metric | How Calculated | Updates |
|--------|---------------|---------|
| **Response Time** | Avg minutes to first reply (last 30 days) | Real-time |
| **Availability** | % of days marked "available" (last 30 days) | Daily |
| **Completion Rate** | Jobs completed / Jobs accepted | Per job |
| **Customer Rating** | Avg 1-5 stars (last 30 days) | Per review |
| **On-Time Rate** | Arrived within window / Total jobs | Per job |

**Response Time Scoring:**
| Avg Response | Score |
|--------------|-------|
| < 2 min | 100 |
| 2-5 min | 90 |
| 5-10 min | 75 |
| 10-30 min | 50 |
| 30-60 min | 25 |
| > 60 min | 10 |

---

## User Flows

### Customer Journey

```
LANDING PAGE
    ↓
PICK CATEGORY (Painting, Assembly, Cleaning, etc.)
    ↓
SEE LIVE LEADERBOARD
    ↓
FILTER: Available Today / This Week / Anytime
    ↓
CLICK PROVIDER → VIEW PROFILE
    ↓
[Portfolio] [Reviews] [Availability] [Price]
    ↓
"CONNECT ON WHATSAPP" BUTTON
    ↓
CHAT DIRECTLY → BOOK → PAY (outside platform)
    ↓
POST-JOB: RATE PROVIDER
```

### Provider Journey

```
APPLY TO JOIN (form + background check)
    ↓
APPROVED → PAY SUBSCRIPTION
    ↓
SET UP PROFILE + PORTFOLIO
    ↓
DOWNLOAD PROVIDER APP (or use WhatsApp)
    ↓
TOGGLE AVAILABILITY: 🟢 Available / 🔴 Not Working
    ↓
RECEIVE INQUIRY NOTIFICATION
    ↓
RESPOND FAST → CLIMB RANKINGS
    ↓
COMPLETE JOB → GET REVIEW
    ↓
SEE WEEKLY LEADERBOARD EMAIL
```

---

## Tech Stack (MVP)

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | Next.js 14 + Tailwind CSS | SEO, speed, easy deployment |
| **Backend** | Supabase (Postgres) | Auth, real-time, generous free tier |
| **WhatsApp** | WhatsApp Business API via Twilio | Easier setup than direct Meta |
| **Payments** | Stripe | Subscription billing |
| **Hosting** | Vercel | Free tier, fast CDN |
| **Images** | Cloudinary | Portfolio photos, optimization |
| **Email** | Resend | Transactional emails, leaderboard updates |

**Estimated MVP Cost:** $0-50/month (until 100+ providers)

---

## Database Schema (Simplified)

```sql
-- Providers
providers (
  id, name, email, phone, city, avatar_url,
  subscription_status, subscription_tier,
  background_check_verified, insurance_verified,
  created_at
)

-- Provider Categories (many-to-many)
provider_categories (
  provider_id, category_id, price_hourly,
  is_primary_category, years_experience
)

-- Leaderboard Scores (recalculated every 15 min)
leaderboard_scores (
  provider_id, category_id, city,
  response_time_avg, availability_pct,
  completion_rate, rating_avg, on_time_rate,
  total_score, rank, updated_at
)

-- Availability (live status)
availability (
  provider_id, status, -- 'available', 'booked', 'offline'
  available_today, available_this_week,
  last_status_change
)

-- Inquiries (WhatsApp tracking)
inquiries (
  id, customer_phone, provider_id, category_id,
  sent_at, provider_replied_at, response_time_seconds,
  status -- 'pending', 'replied', 'booked', 'declined'
)

-- Jobs & Reviews
jobs (
  id, provider_id, customer_phone, category_id,
  scheduled_date, completed_at,
  provider_arrived_at, on_time
)

reviews (
  job_id, rating, comment, would_rehire,
  created_at
)
```

---

## WhatsApp Integration Flow

### Customer → Provider Connection

1. **Customer clicks "Connect"** on provider profile
2. **System generates** unique WhatsApp link with pre-filled message:
   ```
   Hi [Provider Name]! I found you on TaskLeaders for [Category]. 
   I need help with: [Customer types description]
   ```
3. **Customer redirected** to WhatsApp (web or app)
4. **System tracks:** inquiry sent, starts response timer
5. **Provider replies** → webhook captures reply time
6. **Leaderboard updates** in real-time

### Provider Notifications

| Event | Notification |
|-------|-------------|
| New inquiry | WhatsApp + Push + SMS (if opted in) |
| Ranking change | Daily email summary |
| Badge earned | Instant WhatsApp + Email |
| Subscription renewal | 3-day reminder |

---

## Provider Onboarding

### Application Flow

```
STEP 1: Basic Info
- Name, email, phone, city
- Categories (select up to 3)
- Years experience

STEP 2: Verification
- ID upload
- Background check consent ($25 fee or included)
- Insurance certificate (optional but boosts ranking)

STEP 3: Profile Setup
- Photo
- Bio (max 500 chars)
- Portfolio (up to 10 photos)
- Hourly rate per category

STEP 4: Payment
- Subscription plan selection
- Stripe checkout

STEP 5: App Download + Training
- Download provider app
- 5-min video: "How to Win on TaskLeaders"
- Test toggle availability
```

### Vetting Criteria

| Check | Required | Timeline |
|-------|----------|----------|
| ID Verification | Yes | Instant (automated) |
| Background Check | Yes | 24-48 hours |
| Insurance | No (but +10% ranking boost) | Manual review |
| Phone Interview | For Platinum tier only | 15 min call |

---

## Pricing Strategy

### Provider Subscriptions

| Plan | Monthly | Annual | Features |
|------|---------|--------|----------|
| **Starter** | $29 | $290 (2 mo free) | 1 category, basic listing |
| **Pro** | $49 | $490 (2 mo free) | 3 categories, featured badge, analytics |
| **Elite** | $99 | $990 (2 mo free) | Unlimited, top placement, priority support |

### Customer Pricing

| Model | Price | When |
|-------|-------|------|
| **Free** | $0 | Browse, connect, book |
| **Pro Customer** | $9/mo | Priority booking, see "Elite" providers first |

**Decision:** Start with 100% free for customers. Monetize providers only. Add customer Pro tier later if needed.

---

## Launch Strategy

### Phase 1: Pre-Launch (Weeks 1-4)

- [ ] Build MVP (landing page + leaderboard + provider app)
- [ ] Recruit 20-50 seed providers (friends, local FB groups, Nextdoor)
- [ ] Create "Founding Provider" offer: 50% off first 3 months
- [ ] Build waitlist of customers ("Be first to see live rankings")

### Phase 2: Soft Launch (Weeks 5-8)

- [ ] Launch in ONE city (Vancouver?)
- [ ] 3-5 task categories max (Painting, Furniture Assembly, Cleaning, Yard Work, Handyman)
- [ ] Manual onboarding (you approve each provider)
- [ ] Daily check-ins with first 10 providers

### Phase 3: Scale (Months 3-6)

- [ ] Expand to 10 categories
- [ ] Add second city
- [ ] Automate onboarding
- [ ] Introduce customer Pro tier

---

## Success Metrics

| Metric | Month 1 Target | Month 6 Target |
|--------|---------------|----------------|
| Providers | 20 | 200 |
| Customers (unique) | 50 | 1,000 |
| Inquiries sent | 100 | 2,000 |
| Avg response time | < 15 min | < 5 min |
| Job completion rate | 70% | 85% |
| Monthly revenue | $500 | $8,000 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Providers don't respond fast | Gamification + ranking penalty + weekly coaching emails |
| Customers don't leave reviews | Automated follow-up WhatsApp 24h after job |
| Low provider retention | Monthly "State of Your Business" report showing leads generated |
| Quality issues | Three strikes = removal; customer refund guarantee (from our pocket, not provider) |
| WhatsApp API costs | Start with Twilio sandbox; scale to paid only when profitable |

---

## Next Steps

1. **Validate domain:** Secure TaskLeaders.com
2. **Validate demand:** Post in local FB groups: "Would you pay $29/mo for unlimited leads if we ranked you by response speed?"
3. **Build v0.1:** Landing page + waitlist
4. **Recruit 5 beta providers:** Friends, family, local handymen
5. **Build v0.2:** Working leaderboard + WhatsApp integration

---

## Open Questions

1. **Geographic scope:** Start with Vancouver metro? One neighborhood?
2. **Categories priority:** Which 3-5 to launch with?
3. **Background checks:** Use Checkr, Sterling, or manual?
4. **Dispute resolution:** Automated (3 strikes) or manual review?
5. **Mobile apps:** Build native later, or PWA sufficient for MVP?

---

*Document created: March 6, 2026*
*Next review: After Todd feedback*

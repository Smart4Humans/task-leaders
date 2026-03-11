# TaskLeaders — Site Functionality Rules

**Version:** 1.1  
**Date:** March 11, 2026  
**Status:** Coding Reference

---

## 1. Homepage

### Navigation
| Element | Links To | Style |
|---------|----------|-------|
| Logo | Homepage | — |
| TaskLeader Sign In | `taskleader-signin.html` | Secondary text link |
| Become a TaskLeader | `become-task-leader.html` | Primary button |

### Category Display
**Rule:** Display category only if `approved_active_count(category) > 0`.

**Approved Categories (Real Estate / Property Manager target market):**
- Handyman
- Plumbing
- Electrical
- Painting
- Cleaning
- Furniture Assembly
- Moving Help
- Yard Work

**Empty State:** If no categories have supply, show "TaskLeaders coming soon" message. Do not render empty category grid.

---

## 2. Customer Flow

```
Homepage → Category Page → TaskLeader Public Profile → Connect → WhatsApp
```

**Rules:**
- Category Page shows ranked TaskLeaders for selected category
- TaskLeader Public Profile is the conversion/trust page
- Connect CTA opens WhatsApp (external)
- No in-app messaging at MVP

---

## 3. Provider Recruitment

```
Homepage / Outreach → Become a TaskLeader → Application Submitted
                                                  ↓
                              Founder WhatsApp Call (screening)
                                                  ↓
                                       Approval Decision
                                                  ↓
                            ┌─────────────────────┴─────────────────────┐
                       REJECTED                                    APPROVED
                            ↓                                           ↓
                     (notification)                        TaskLeader Profile Setup
                                                                  (magic link)
```

**Rule:** TaskLeader Profile Setup is post-approval only. No public navigation.

---

## 4. Returning TaskLeader Access

```
TaskLeader Sign In → Magic Link Sent → Email Click → TaskLeader Profile Setup (edit mode)
```

**Rules:**
- Entry: `taskleader-signin.html`
- Auth: Email magic link (passwordless)
- Eligibility: Approved TaskLeaders only
- Same page used for initial setup and edits
- Pre-filled with existing data when returning

---

## 5. TaskLeader Public Profile

### Data Source
TaskLeader Profile Setup submissions only.

### Location Display
- Top location: Single approved city (primary)
- Service areas: Listed separately

### Trust Signals (MVP)
| Signal | Format |
|--------|--------|
| Response | Minutes |
| Reliability | Percentage |
| Price | Hourly rate |

**Rule:** Only display tracked, supportable data.

---

## 6. Visibility & Integrity

### Provider Status
| Status | Public | Edit Access |
|--------|--------|-------------|
| `pending` | Hidden | No |
| `approved` + `is_active=true` | Visible | Yes |
| `approved` + `is_active=false` | Hidden | Yes |
| `rejected` / `suspended` | Hidden | No |

### Public Profile Requirements
- Business/provider name
- Category (from approved set)
- Primary service area
- WhatsApp number
- Response time
- Reliability score
- Hourly rate

### Unsupported Features
**Rule:** Public pages must not imply unsupported functionality.

Do not show:
- Fake availability counts
- Real-time metrics without data
- "X providers available now" without tracking

---

## 7. Category Standards

| ID (URL/param) | Display Name | Icon |
|----------------|--------------|------|
| `handyman` | Handyman | 🔧 |
| `plumbing` | Plumbing | 🚿 |
| `electrical` | Electrical | ⚡ |
| `painting` | Painting | 🎨 |
| `cleaning` | Cleaning | 🧹 |
| `furniture-assembly` | Furniture Assembly | 📦 |
| `moving` | Moving Help | 🚚 |
| `yard-work` | Yard Work | 🌿 |

**Rules:**
- IDs: kebab-case lowercase
- Display names: Full words, Title Case
- Consistent across all pages, URLs, APIs

---

## 8. Launch Rules

- Site can go live with 1+ approved TaskLeader
- No hard minimum required
- Categories appear as supply becomes available
- Marketing scales with supply

---

## Implementation Checklist

- [ ] Homepage categories filtered by approved supply count
- [ ] TaskLeader Profile Setup requires approval
- [ ] TaskLeader Sign In restricted to approved providers
- [ ] Public profiles use Profile Setup data only
- [ ] Location display: primary city + service areas
- [ ] Trust signals show tracked data only
- [ ] No unsupported features implied
- [ ] Category IDs match approved set exactly
- [ ] Display names use standardized labels

---

## Related

- `CATEGORY_STANDARDS.md` — Category reference
- `TASKLEADERS_MVP_WORKING_BRIEF.md` — MVP direction
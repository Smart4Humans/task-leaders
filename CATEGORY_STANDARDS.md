# TaskLeaders — Standardized Category Labels

**Version:** 1.0  
**Date:** March 11, 2026  
**Status:** Approved for Real Estate / Property Manager Target Market

---

## Approved Category Set (8 Categories)

| ID (slug) | Display Name | Icon | Usage |
|-----------|--------------|------|-------|
| `handyman` | Handyman | 🔧 | URLs, databases, UI |
| `plumbing` | Plumbing | 🚿 | URLs, databases, UI |
| `electrical` | Electrical | ⚡ | URLs, databases, UI |
| `painting` | Painting | 🎨 | URLs, databases, UI |
| `cleaning` | Cleaning | 🧹 | URLs, databases, UI |
| `furniture-assembly` | Furniture Assembly | 📦 | URLs, databases, UI |
| `moving` | Moving Help | 🚚 | URLs, databases, UI |
| `yard-work` | Yard Work | 🌿 | URLs, databases, UI |

---

## Standardization Rules

### 1. ID/Slug Format
- Use kebab-case (lowercase with hyphens)
- Used in: URLs, database fields, form values, API endpoints
- Example: `furniture-assembly`, `yard-work`

### 2. Display Name Format
- Use Title Case for multi-word categories
- Use full descriptive names (not abbreviations)
- Used in: Homepage tiles, category page headers, profile pages, dropdowns
- Example: `Furniture Assembly` (not `Assembly`), `Moving Help` (not `Moving`)

### 3. Consistency Requirements
- Same ID used across all versions (v0.2, v0.3, v0.4)
- Same display name used across all pages (Homepage, Category, Profile, Setup)
- Same icon used consistently per category

---

## Files to Maintain Consistency

### Homepage
- Category grid display names
- JavaScript category array

### Category Pages
- Page title (`<title>`)
- Page header (H1)
- URL parameter validation

### TaskLeader Profile Setup
- Primary service dropdown
- Additional services checkboxes
- Pricing display names

### TaskLeader Public Profile
- Service badges
- Category rankings

### Become a TaskLeader
- Service category dropdown

### Admin
- Provider management dropdowns
- Category filters

### Documentation
- MVP Working Brief
- Flow maps
- Technical specs

---

## Target Market Alignment

These 8 categories serve the **Real Estate / Property Manager** target market:

| Category | Prep-for-Listing Use Case |
|----------|---------------------------|
| Handyman | General repairs, fixes, installations |
| Plumbing | Leaks, fixtures, last-minute repairs |
| Electrical | Outlets, lighting, minor electrical |
| Painting | Touch-ups, full rooms, refresh |
| Cleaning | Deep clean, move-in/move-out ready |
| Furniture Assembly | Staging, setup, installation |
| Moving Help | Furniture moving, staging support |
| Yard Work | Curb appeal, cleanup, basic landscaping |

---

## Change History

| Date | Change | Notes |
|------|--------|-------|
| 2026-03-11 | Standardized labels | Fixed inconsistencies across v0.2, v0.3, v0.4 |
| 2026-03-11 | Removed HVAC | Not core to RE/PM prep-for-listing work |
| 2026-03-11 | Locked 8-category set | Approved for MVP target market |

---

## Enforcement

When adding new categories or modifying existing:
1. Update this document first
2. Update all affected HTML files
3. Update database enums/validation
4. Update API documentation
5. Verify consistency across all touchpoints
# TaskLeaders

**Hyper-local service provider marketplace.**

Connect with local service providers via WhatsApp. No accounts, no fees, no middleman.

---

## Quick Links

| Resource | Link |
|----------|------|
| **Product Spec** | [PRODUCT_SPEC.md](PRODUCT_SPEC.md) — Canonical definition |
| Live Demo | https://smart4humans.github.io/task-leaders/v0.2/ |
| Repository | https://github.com/Smart4Humans/task-leaders |

---

## What is TaskLeaders?

A marketplace where customers find service providers ranked by **response speed, reliability, and price**.

- 🟢 **Customers:** Browse, compare, connect via WhatsApp — no account needed
- 🔧 **Providers:** Get qualified leads delivered to your WhatsApp — subscription-based

---

## Core Principles

1. **Facilitate introductions only** — No payments, no bookings handled
2. **WhatsApp-native** — All communication through WhatsApp
3. **Speed-ranked** — Fast responders win
4. **Minimal & fast** — Utility-first design

---

## Project Status

**Phase:** MVP Development  
**Goal:** 20–30 providers, 20+ real customer conversations

See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) for full details.

---

## File Structure

```
task-leaders-deploy/
├── PRODUCT_SPEC.md          # 🎯 Canonical product definition
├── README.md                # This file
├── OUTREACH_PLAN.md         # Provider acquisition strategy
├── v0.2/                    # Current version
│   ├── homepage.html
│   ├── category.html
│   ├── mike.html
│   └── ...
└── docs/                    # Implementation details
    ├── WHATSAPP_CONSENT_TEMPLATES.md
    └── CONSENT_IMPLEMENTATION.md
```

---

## Development

Built with vanilla HTML/CSS/JS, deployed to GitHub Pages.

```bash
# Local development
cd v0.2
python -m http.server 8000

# Deploy
git add .
git commit -m "Update"
git push origin main
```

---

## Contact

Todd — todd@taskleaders.com

---

*TaskLeaders © 2026*

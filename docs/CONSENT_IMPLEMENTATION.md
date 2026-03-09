# Task Leaders — WhatsApp Consent Implementation Guide

## Overview
This implementation adds GDPR/WhatsApp-compliant consent collection to the customer inquiry flow.

## Files Modified
- `v0.2/mike.html` — Example provider profile with consent modal

## Key Features

### 1. Consent Collection
| Field | Required | Purpose |
|-------|----------|---------|
| First name | No | Personalization |
| WhatsApp number | Yes | Communication |
| Required consent | **Yes** | Core messaging (responses, follow-ups, reviews) |
| Marketing consent | No | Promotional messages |

### 2. UI Components

#### Consent Modal (Step 1)
```
┌─────────────────────────────────────────┐
│  Connect with Mike                      │
│                                         │
│  [Your first name (optional)]           │
│  [WhatsApp number *]                    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ ☑ Required: I agree to receive  │    │
│  │   WhatsApp messages about this  │    │
│  │   inquiry...                    │    │
│  │                                 │    │
│  │ ☐ Optional: Also send me offers │    │
│  │   and updates...                │    │
│  └─────────────────────────────────┘    │
│                                         │
│  By connecting, you agree to our        │
│  [Terms] and [Privacy]                  │
│                                         │
│  [Continue]                             │
│  [Cancel]                               │
└─────────────────────────────────────────┘
```

#### Verification Step (Step 2)
```
┌─────────────────────────────────────────┐
│  Enter Code                             │
│  We sent a 6-digit code to your WhatsApp│
│                                         │
│  [1] [2] [3] [4] [5] [6]                │
│                                         │
│  [Connect with Mike]                    │
│  [Change Number]                        │
└─────────────────────────────────────────┘
```

### 3. Data Structure

```javascript
{
  // Customer Info
  name: "Todd",                          // Optional
  phone: "+16045551234",                 // Required, E.164 format
  
  // Consent
  consentRequired: true,                 // Required checkbox
  consentMarketing: false,               // Optional checkbox
  
  // Inquiry Context
  providerId: "mike-johnson",            // Who they contacted
  providerName: "Mike",
  category: "painting",                  // Service category
  
  // Tracking
  timestamp: "2026-03-09T16:30:00Z",     // When inquiry started
  verified: true,                        // After code verification
  verifiedAt: "2026-03-09T16:32:00Z",    // When verified
  
  // System
  ipAddress: "...",                      // Server-side
  userAgent: "...",                      // Server-side
  source: "profile-page"                 // Where they came from
}
```

## Backend API Endpoints

### POST /api/inquiries
Create a new inquiry (after verification).

**Request:**
```json
{
  "name": "Todd",
  "phone": "+16045551234",
  "consentRequired": true,
  "consentMarketing": false,
  "providerId": "mike-johnson",
  "category": "painting",
  "timestamp": "2026-03-09T16:30:00Z",
  "verified": true,
  "verifiedAt": "2026-03-09T16:32:00Z"
}
```

**Response:**
```json
{
  "inquiryId": "inq_abc123",
  "status": "connected",
  "whatsappLink": "https://wa.me/16045551234?text=..."
}
```

### POST /api/verify/send
Send verification code.

**Request:**
```json
{
  "phone": "+16045551234"
}
```

### POST /api/verify/check
Verify the code.

**Request:**
```json
{
  "phone": "+16045551234",
  "code": "123456"
}
```

## WhatsApp Message Templates

Templates must be pre-approved by Meta. See `WHATSAPP_CONSENT_TEMPLATES.md` for full list.

### Quick Reference

| Template | Use Case | Category |
|----------|----------|----------|
| `follow_up_no_response` | 24h after no reply | UTILITY |
| `review_request` | Ask for rating | FEEDBACK |
| `re_engagement` | 7 days later | UTILITY |
| `new_provider_alert` | Monthly updates | MARKETING* |
| `seasonal_offer` | Seasonal promotions | MARKETING* |

*Requires marketing consent

## Compliance Checklist

- [x] Explicit opt-in checkbox (required consent)
- [x] Separate unchecked box for marketing
- [x] Terms & Privacy Policy links
- [x] Clear purpose description
- [x] STOP handling (reply STOP to unsubscribe)
- [x] Data retention policy (2 years)
- [x] Timestamp for audit trail

## Applying to Other Profiles

To apply this consent flow to another provider profile:

1. Copy the modal HTML and CSS from `mike.html`
2. Update `customerData` object with correct provider info:
   ```javascript
   providerId: 'provider-slug',
   providerName: 'First Name',
   category: 'category-slug'
   ```
3. Update WhatsApp link with correct provider number
4. Test the full flow

## Testing Checklist

- [ ] Modal opens on "Message" button click
- [ ] Name field is optional
- [ ] Phone validation works
- [ ] Cannot proceed without checking required consent
- [ ] Can proceed without marketing consent
- [ ] Error messages display correctly
- [ ] Verification code UI works
- [ ] WhatsApp opens with pre-filled message
- [ ] Customer data logs correctly

## Next Steps

1. Build backend API for verification codes
2. Submit message templates to Meta for approval
3. Set up webhook for STOP/opt-out handling
4. Create admin dashboard to view inquiries
5. Apply template to all provider profiles

---

*Document created: March 9, 2026*
*Status: Frontend complete, backend pending*

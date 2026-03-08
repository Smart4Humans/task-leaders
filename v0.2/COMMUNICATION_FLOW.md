# Task Leaders — Communication Flow Templates

## Overview
All WhatsApp communication is direct between Customer and Provider. Platform only sends:
1. Customer verification code (signup)
2. Follow-up feedback requests (24-48h after inquiry)

---

## 1. Customer Signup Verification

**Trigger:** Customer enters phone number during signup
**Sender:** Task Leaders (platform)
**Recipient:** Customer

```
Your Task Leaders verification code: 847291

Enter this code to complete your signup.
Code expires in 10 minutes.
```

---

## 2. Post-Inquiry Feedback Request

**Trigger:** 24-48 hours after customer clicks "Show Phone Number" on provider profile
**Sender:** Task Leaders (platform)
**Recipient:** Customer
**Condition:** Only if customer hasn't already replied to a previous feedback request for this inquiry

### Version A: Simple (Recommended for MVP)

```
Hi! You contacted Mike's Painting yesterday through Task Leaders.

Quick question to help others find great Taskers:

Did you end up hiring Mike?
Reply: YES or NO

Thanks!
- Task Leaders
```

### Version B: Detailed (More metrics)

```
Hi! You contacted Mike's Painting yesterday through Task Leaders.

Help others find great Taskers — 3 quick questions:

1. Did you hire Mike?
   Reply: YES or NO

2. If YES: Did they arrive on time?
   Reply: ON TIME, LATE, or NO SHOW

3. Overall experience?
   Reply: 5 (excellent), 4, 3, 2, or 1 (poor)

Your feedback helps Taskers improve. Thanks!
- Task Leaders
```

### Version C: Single-Tap (Best UX)

```
Hi! You contacted Mike's Painting yesterday.

How did it go? Tap to rate:

👍 Hired + Great
👎 Hired + Poor  
❌ Didn't hire

Thanks for helping others find great Taskers!
```

---

## 3. Customer Incentive Follow-up (if no response)

**Trigger:** 48 hours after first feedback request, no reply
**Sender:** Task Leaders (platform)
**Recipient:** Customer

```
Hi! Still hoping for your feedback on Mike's Painting.

Your review helps other customers make better choices.

Plus: Every review enters you into our monthly $50 gift card draw! 🎁

Reply with: YES (hired) or NO (didn't hire)
```

---

## 4. Provider Notification (Optional)

**Trigger:** New inquiry received
**Sender:** Task Leaders (platform)
**Recipient:** Provider
**Note:** Only if provider opts in to notifications

```
🔔 New Task Leaders inquiry!

From: Sarah M.
Service: Interior painting
Time: Just now

Your average response time: 1.2 min
Fastest Tasker this week: 0.8 min

Reply quickly to maintain your rank!
```

---

## 5. Provider Weekly Summary (Optional)

**Trigger:** Every Monday
**Sender:** Task Leaders (platform)
**Recipient:** Provider

```
📊 Your Task Leaders Weekly Summary

This week:
• 12 new inquiries
• 10 replied (83% response rate)
• 8 hired (80% conversion)
• 4.9★ average rating

Your ranking: #3 in Painting (↑ 2 spots!)

Keep up the great work!
```

---

## Response Handling

### Customer Replies to Feedback Request

**If "YES" (hired):**
- Mark job as completed
- Request rating + on-time feedback (if using Version B)
- Update provider's completion rate

**If "NO" (didn't hire):**
- Mark inquiry as closed
- No rating requested
- Still counts toward provider's "response rate" (they replied, even if no job)

**If no reply after 72 hours:**
- Inquiry expires
- No metrics recorded
- Provider's stats unchanged

---

## Metrics Calculated from Feedback

| Metric | Source | Calculation |
|--------|--------|-------------|
| Response Time | Platform | Inquiry timestamp → Provider's first WhatsApp reply (if provider shares read receipt) |
| Completion Rate | Customer | "YES, hired" replies / Total inquiries |
| On-Time Rate | Customer | "ON TIME" replies / "YES, hired" replies |
| Rating | Customer | Average of 1-5 star ratings |
| Would Rehire | Customer | Percentage of "YES" to "Would you hire again?" |

---

## Privacy Notes

- Platform NEVER reads message content between Customer and Provider
- Platform ONLY knows: inquiry sent, feedback received
- All negotiation, scheduling, pricing happens privately in WhatsApp
- Customer phone number is verified but not shared with other customers
- Provider phone number is visible only after customer clicks "Show Number"

---

## Anti-Gaming Measures

| Attack | Defense |
|--------|---------|
| Provider asks friends to inquire + give 5 stars | Rate limiting: Max 1 inquiry per customer per provider per month; phone number verification required |
| Customer never replies to feedback | Incentive: Gift card draw; no negative impact on provider (neutral is better than bad) |
| Fake customer accounts | SMS verification + email verification + rate limiting |
| Provider begs for good ratings | Allowed! But customer can still rate honestly; "Would rehire" is the real metric |

---

## Open Questions

1. Should we allow providers to opt OUT of notifications entirely?
2. Should customers be able to leave detailed text reviews, or just ratings?
3. How do we handle disputes (customer says "NO SHOW", provider says "they cancelled")?
4. Should we show customers their own "reviewer reputation" (how often they leave feedback)?

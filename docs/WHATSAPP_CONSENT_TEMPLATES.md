# Task Leaders — WhatsApp Consent & Messaging Templates

## Customer Opt-In Flow

### Step 1: Pre-WhatsApp Consent Screen

```
┌─────────────────────────────────────────┐
│  Connect with Mike (Painter)            │
│                                         │
│  Average response: 4 minutes            │
│  ⭐ 4.8 (23 reviews) · 47 jobs completed│
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  We'll open WhatsApp with your message. │
│                                         │
│  ☑️ I agree to receive messages via     │
│     WhatsApp about this inquiry,        │
│     including:                          │
│     • Responses from Mike               │
│     • Follow-up if needed               │
│     • Review request after the job      │
│                                         │
│     [Optional] Occasional updates about │
│     new Task Leaders in my area         │
│     ☐ Yes, send me offers and updates   │
│                                         │
│  By continuing, you agree to our        │
│  [Terms of Service] and [Privacy Policy]│
│                                         │
│  [Confirm & Open WhatsApp]              │
│                                         │
└─────────────────────────────────────────┘
```

---

### Step 2: WhatsApp Pre-filled Message

**Customer's phone opens WhatsApp with:**

```
Hi Mike! I found you on Task Leaders for painting. 

I need help with: [Customer types here]

I'm available: [Customer types here]

— [First Name, if known]
```

**If name unknown, message is:**
```
Hi Mike! I found you on Task Leaders for painting. 

I need help with: [Customer types here]

I'm available: [Customer types here]
```

---

## WhatsApp Message Templates (Meta-Approved)

### Template 1: Follow-Up (No Response)
**Use:** 24 hours after inquiry if provider hasn't responded
**Category:** UTILITY

```
Hi {{1}}! You reached out to {{2}} for {{3}} yesterday. 

Haven't heard back? Here are 3 other top-rated {{4}}s available now:

{{5}}

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Customer first name
- {{2}} = Provider name
- {{3}} = Category (painting, plumbing, etc.)
- {{4}} = Category plural (painters, plumbers, etc.)
- {{5}} = List of 3 alternative providers with links

---

### Template 2: Review Request
**Use:** 48 hours after inquiry
**Category:** FEEDBACK

```
Hi {{1}}! How did {{2}} do on your {{3}} job?

Quick rating:
• Reply 5 = Excellent
• Reply 4 = Good  
• Reply 3 = Okay
• Reply 2 = Could be better
• Reply 1 = Poor

Your feedback helps other customers find great Task Leaders.

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Customer first name
- {{2}} = Provider name
- {{3}} = Category

---

### Template 3: Review Follow-Up (Detailed)
**Use:** After customer sends 1-5 rating
**Category:** FEEDBACK

```
Thanks for rating {{1}} a {{2}}/5! 

Want to add a quick comment? (Optional)

Your review: [type here]

Or just reply DONE to finish.
```

**Variables:**
- {{1}} = Provider name
- {{2}} = Rating number

---

### Template 4: Re-engagement (Still Looking)
**Use:** 7 days after inquiry, no job confirmed
**Category:** UTILITY

```
Hi {{1}}! Still looking for help with {{2}}?

3 new {{3}}s just joined Task Leaders in your area:

{{4}}

Get fresh quotes in 2 minutes.

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Customer first name
- {{2}} = Original job description (shortened)
- {{3}} = Category plural
- {{4}} = List of new providers

---

### Template 5: New Provider Alert (Marketing Opt-In Only)
**Use:** Monthly to customers who checked marketing box
**Category:** MARKETING

```
Hi {{1}}! New Task Leaders are available in {{2}}:

{{3}}

Need something done? Get quotes in 2 minutes: {{4}}

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Customer first name
- {{2}} = Area/neighborhood
- {{3}} = List of new providers with specialties
- {{4}} = Short link to category page

---

### Template 6: Seasonal/Triggered Offer (Marketing Opt-In Only)
**Use:** Seasonal or based on past inquiry category
**Category:** MARKETING

```
Hi {{1}}! {{2}} season is here 🍂

Top-rated {{3}}s are booking up fast. 

Secure your spot: {{4}}

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Customer first name
- {{2}} = Season/event (Spring cleaning, Holiday prep, etc.)
- {{3}} = Category plural
- {{4}} = Link to category page

---

### Template 7: Referral Request
**Use:** After positive review (4-5 stars)
**Category:** UTILITY

```
Thanks for the great review of {{1}}! 🎉

Know someone who needs {{2}} help?

Share this link and they'll get priority booking:
{{3}}

Reply STOP to unsubscribe.
```

**Variables:**
- {{1}} = Provider name
- {{2}} = Category
- {{3}} = Referral link with tracking

---

## System Messages (No Template Required — Session Window)

These can be sent free-form within 24 hours of customer contact:

### Immediate Confirmation
```
✓ Your message was sent to Mike!

He typically responds in 4 minutes.

You'll get his reply right here in WhatsApp.
```

### Provider Response Delay Warning
```
Mike hasn't responded yet (it's been 2 hours).

Want us to send your request to 2 other painters?

Reply YES and we'll find you backup options.
```

### Job Completion Check-In
```
Did you book Mike for your painting job?

Reply:
• YES — We'll send a review request when you're done
• NO — We can connect you with others
• STILL TALKING — No problem, take your time!
```

---

## Opt-Out Handling

### Automatic Response to STOP

```
You've been unsubscribed from Task Leaders messages.

You can still use our service to connect with Task Leaders, but you won't receive follow-ups or offers.

To resubscribe, reply START or contact support@taskleaders.com
```

### Database Action
- Set `whatsapp_opt_out = true`
- Stop all template messages
- Allow session messages only (customer-initiated)

---

## Data Collection Summary

| Field | Required | Source | Stored |
|-------|----------|--------|--------|
| Phone number | Yes | WhatsApp sender ID | Hashed |
| First name | No | WhatsApp profile OR ask | Plain text |
| Consent timestamp | Yes | Checkbox click | ISO 8601 |
| Marketing opt-in | No | Checkbox | Boolean |
| Inquiry category | Yes | Page context | Category ID |
| Inquiry details | No | WhatsApp message | Text |
| Provider contacted | Yes | Button click | Provider ID |
| Connection timestamp | Yes | Server log | ISO 8601 |

---

## Compliance Checklist

- [ ] Opt-in checkbox clearly visible
- [ ] Terms and Privacy Policy linked
- [ ] Marketing opt-in is separate (unchecked by default)
- [ ] STOP handling automated
- [ ] Data retention: 2 years
- [ ] Template messages approved by Meta
- [ ] No promotional messages without explicit marketing consent

---

## Next Steps

1. Submit templates to Meta for approval (3-5 business days)
2. Implement consent screen in frontend
3. Set up webhook handlers for STOP/START
4. Build message scheduling system
5. Test flow end-to-end

---

*Document created: March 9, 2026*
*Status: Ready for implementation*

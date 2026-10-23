# M13B — DNS and Resend readiness checklist (read-only)

**Nothing was changed.** The "Observed" column comes from public DNS lookups (`dig`) against the
authoritative servers `ns1.vercel-dns.com` / `ns2.vercel-dns.com`. No Resend dashboard or API was accessed.
Every change is an **[APPROVAL]** step.

| # | Item | Observed (public DNS) | Expected | Status |
| --- | --- | --- | --- | --- |
| 1 | DNS host | NS `ns1/ns2.vercel-dns.com` | — | DNS records are edited in Vercel |
| 2 | DKIM for `mail.teambalancepro.com` | `resend._domainkey.mail.teambalancepro.com` TXT `p=MIGfMA0G…` (RSA key present) | The Resend-provided DKIM key | ✅ present; confirm it matches the Resend dashboard |
| 3 | SPF (bounce domain) | `send.mail.teambalancepro.com` TXT `v=spf1 include:amazonses.com ~all` | Resend's SPF | ✅ present |
| 4 | Bounce MX | `send.mail.teambalancepro.com` MX `10 feedback-smtp.us-east-1.amazonses.com` | Resend's MX | ✅ present |
| 5 | Root SPF (inbound forwarding) | `teambalancepro.com` TXT `v=spf1 include:spf.improvmx.com ~all` | Unrelated to RSVP sending (it covers the root domain's own mail) | ℹ️ no change needed |
| 6 | **DMARC** | **None**: `_dmarc.teambalancepro.com` and `_dmarc.mail.teambalancepro.com` have no TXT (authoritative SOA only) | `v=DMARC1; p=none; adkim=r; aspf=r` (append `rua` once a reporting mailbox exists) | ❌ **blocker** |
| 7 | Resend domain verified | Not checked (dashboard) | Resend → Domains shows `mail.teambalancepro.com` **Verified** | ☐ owner checks |
| 8 | Provider quota | Not checked | The Resend plan's daily / monthly limits ≥ 2 × (100 RSVP per day + account email) | ☐ owner checks |
| 9 | Rate limit | Docs: 10 requests per second per team | RSVP is paced at 4 per second (code); account email shares the rest | ✅ by design |
| 10 | Open / click tracking | Not checked | **OFF** for the sending domain (click tracking would rewrite `/attend?c=…#token` links) | ☐ owner checks |
| 11 | Reply-to | None (`noreply@`) | Per decision D9 (recommended: a monitored support address) | ☐ decision |
| 12 | Account / security email | Working in Production (existing path) | Unchanged by M13B (separate transport path; tested) | ☐ re-test after deploy |
| 13 | Webhook signature verification | Code verifies Svix signatures (published test vector) and fails closed without a secret | An endpoint registered with `email.bounced` and `email.complained` only, plus `RESEND_WEBHOOK_SECRET` (Production only) | ☐ [APPROVAL] (runbook §6) |

## Owner verification steps (each read-only unless marked)

1. **Resend → Domains → `mail.teambalancepro.com`:**
   - **Verified**, with the DKIM / SPF / MX values matching rows 2–4;
   - the region is noted (the MX points at `us-east-1`).
2. **Resend → Settings → Usage / Billing:** write down the daily and monthly limits and the rate limit.
   Confirm they are at least 2 × (100 + the typical daily account emails).
3. **Resend → Domains → `mail.teambalancepro.com` → tracking:** open and click tracking **off**. Changing it
   is **[APPROVAL]**.
4. **DMARC [APPROVAL]** in Vercel DNS: add the TXT record `_dmarc.teambalancepro.com` =
   `v=DMARC1; p=none; adkim=r; aspf=r`
   (P8B.3: no `rua` until a reporting mailbox is confirmed to exist; then append `; rua=mailto:<mailbox>`).
   - Monitoring policy: `p=none` for at least 7 days, reviewing the aggregate reports once `rua` is set.
   - Then `p=quarantine; pct=25`, and later 100 if the reports are clean.
5. **End-to-end authentication test:**
   1. Request a password reset for an internal Gmail account.
   2. Open "Show original". It must show `SPF: PASS`, `DKIM: PASS` and, after step 4, `DMARC: PASS`.
   3. `From` must be the Production `EMAIL_FROM`: `Team Balance Pro <no-reply@mail.teambalancepro.com>`
      [VERIFIED in P8B.2b].
6. **Account email still works:**
   - verification and password reset arrive within a minute;
   - no `List-Unsubscribe` header on them (by design).
7. **Webhook:** follow runbook §6. Verify the signed bounce, the complaint, the duplicate replay, the
   unsigned 401 and the payload fields.

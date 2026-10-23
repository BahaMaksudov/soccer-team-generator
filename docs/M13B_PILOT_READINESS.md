# M13B — RSVP invitation emails: controlled pilot readiness

**Status:** M13B P1–P7 are complete on `feature/m13b-p1-player-emails`. Nothing is merged, deployed or
migrated, and no real RSVP email has ever been sent. Starting the pilot requires the owner's explicit
approval of every step marked **[APPROVAL]**. This document is a plan; it changes nothing by itself.

Reversibility legend:
- **R** — reversible by turning a switch off or reverting code;
- **I** — irreversible (schema migrations once applied, data already anonymized, emails already
  delivered).

---

## 1. Where things stand (default-off)

| Piece | Current state | How it is switched off |
| --- | --- | --- |
| RSVP delivery | `rsvpDeliveryMode()` returns `disabled` in every production build (Production, Preview, `next start`). There is no live mode in code. | Built in (R). |
| Send button / API | Shown disabled. `POST rsvp-send` returns 403 `DELIVERY_DISABLED` before reading anything. | Follows the delivery mode (R). |
| Queue continuation (cron) | Reports `{ disabled: true }` and claims nothing. | Follows the delivery mode (R). |
| Webhook `/api/email/webhooks/resend` | Returns 503 and processes nothing. | Without `RESEND_WEBHOOK_SECRET` (R). |
| Retention cleanup | Built (`runRsvpRetention`); nothing calls it. | Not scheduled (R). Its effects are I. |
| Account / security emails | Unchanged path (`src/lib/email/index.ts` → `getEmailTransport`). Never consults suppression and never carries unsubscribe headers (source-guard tests). | — |

## 2. Migration order and rollback limits

Apply with `prisma migrate deploy`, in this order, all additive:

1. `20261201120000_m13b_p1_player_contact_email`
2. `20261205120000_m13b_p3_email_suppression`
3. `20261210120000_m13b_p4_rsvp_sending`
4. `20261212120000_m13b_p4_quota_ledger`
5. `20261215120000_m13b_p5_send_attestation`
6. `20261220120000_m13b_p6_delivery_management`
7. `20261225120000_m13b_p7_retention`

- **Before migrating:** take a Neon branch / snapshot **[APPROVAL]**. Run migrations only with the
  documented production procedure, never from a laptop session against Production by accident.
- **What the migrations change:** they only add tables, columns, enums, indexes and CHECKs. The existing app
  (`main`) keeps working on the migrated schema, so deploying the code later, or reverting it, doesn't
  require a down-migration.
- **Rollback notes:** each migration's header has them. Limits:
  - enum values (`RECIPIENT_REQUEST` etc.) can't be dropped in place;
  - dropping M13B tables after the pilot deletes the opt-out and suppression records. **Don't do that**: they
    are what keeps unsubscribed people from being emailed again;
  - anonymization done by the retention job can't be undone (I).
- **Existing data:** the P1 contact fields start empty. Any contact entered before P6 starts *unconfirmed*
  and is never emailed until an organizer confirms it.

## 3. Prerequisites (all must be done before the first real email)

1. **Privacy Policy and Terms published [APPROVAL].** Review `docs/legal/privacy-policy-m13b-draft.md` and
   `docs/legal/terms-m13b-draft.md`, settle their open decisions, then publish and update the effective date.
   Legal review is recommended, especially for guardian / minor contacts.
2. **Deliverability checklist (section 4) complete** on the sending domain.
3. **Webhook verified** with a real signed test event (section 5).
4. **Retention schedule decided:** run `runRsvpRetention` daily (dry-run first; section 8).
5. **Live transport integrated** behind a pilot allowlist (section 6). That code change is reviewed
   separately.
6. **Monitoring in place** (section 9).

## 4. Deliverability checklist (sending domain; no DNS or Resend changes made yet)

Current sender: `EMAIL_FROM` (e.g. `TeamBalance Pro <noreply@mail.teambalancepro.com>`), via Resend.

| Item | Check | Owner action |
| --- | --- | --- |
| Resend verified domain | Resend dashboard → Domains: `mail.teambalancepro.com` shows **Verified**. | Verify; no change if already verified. |
| SPF | The Resend-provided SPF record (on the `send` / bounce subdomain Resend specifies) is present and passes. | DNS **[APPROVAL]**. |
| DKIM | Resend's DKIM `TXT` record(s) present; a test email's headers show `dkim=pass` for the sending domain. | DNS **[APPROVAL]**. |
| DMARC | A `_dmarc` record exists for the organizational domain `teambalancepro.com` (or the subdomain). Start with `p=none; rua=mailto:<monitored address>`, then move to `quarantine` after clean reports. **Currently missing: blocker.** | DNS **[APPROVAL]**. |
| Alignment | The From domain aligns with the DKIM `d=` domain (relaxed alignment is fine). | Check in a test email's headers. |
| Sender identity | Display name "TeamBalance Pro", a monitored reply path decided (reply-to or none), and the footer identifying the organization and why the recipient gets the email (already in the template). | Decide the reply-to. |
| One-click unsubscribe | Test email headers contain `List-Unsubscribe: <https://…/api/email/unsubscribe/one-click?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Gmail / Yahoo show "Unsubscribe". | Check in test email. |
| Provider limits | The Resend plan's daily / monthly sending limit and per-second rate cover pilot volume (app allowance: Free / Trial 20 per day and 100 per month; Pro / LEGACY 50 per day and 500 per month per organization). | Confirm the plan **[APPROVAL]** if billing changes. |
| Bounce / complaint webhook | Registered and verified (section 5). | **[APPROVAL]**. |
| Rendering | Test invitations (player, guardian, linked account; long names; no venue / deadline) checked in Gmail web + mobile, Apple Mail iOS and Outlook. Buttons tappable, the text version readable, nothing clipped. | Send to internal test inboxes only. |
| Content | The subject has no personal data (`RSVP: <match> — <date/time>`). No tracking pixels or link rewriting: **disable Resend open / click tracking** for this domain or stream. Click tracking would rewrite the `#token` links. | Check Resend settings. |

## 5. Webhook verification procedure (pilot setup only)

1. **[APPROVAL]** In the Resend dashboard, create a webhook endpoint
   `https://teambalancepro.com/api/email/webhooks/resend` with events `email.bounced` and `email.complained`
   only. Copy the signing secret (`whsec_…`).
2. **[APPROVAL]** Set `RESEND_WEBHOOK_SECRET` in Vercel **Production** only (not Preview), then redeploy.
3. Produce a signed `email.bounced`. Resend's testing documentation lists simulator addresses (for example
   `bounced@resend.dev` and `complained@resend.dev`); confirm this in its current docs. A test send to one of
   them comes from the live transport, so do this only after section 6 is approved, from a pilot
   organization, or with a one-off operator script. Otherwise use the dashboard's test-event feature if it
   offers one.
4. **Expect:**
   - HTTP 200 with `{"ok":true,"status":"processed","outcome":"SUPPRESSED"}`;
   - one `EmailWebhookEvent` row (no address);
   - one `GlobalEmailSuppression` row for the test address with reason `HARD_BOUNCE`.

   Replaying the same event in the dashboard must give `"status":"duplicate"`.
5. **Negative checks:**
   - `curl -X POST` with a wrong signature → 401;
   - an old timestamp (more than 5 minutes) → 401;
   - more than 256 KB → 413.
6. Compare the real payload's fields (`type`, `data.to[]`, `data.bounce.type`) with the handler. If Resend's
   payload differs from its documentation, **stop** and fix the handler before relying on it.
7. Delete the test suppression row afterwards, if it used a real internal address.

Rollback (R): unset the secret (back to 503) and disable the endpoint in Resend.

## 6. Live transport integration (separate, reviewed change; not built)

Minimum design for the pilot code change:
- **Explicit mode:** a third mode in `rsvpDeliveryMode()`, `live`, which requires **all** of:
  - `NODE_ENV=production`;
  - `VERCEL_ENV=production`, so it can never run in Preview;
  - `RSVP_EMAIL_DELIVERY=live`;
  - a non-empty `RSVP_EMAIL_PILOT_ORGS` allowlist (organization ids).

  Anything else stays `disabled`.
- **Allowlist enforced server-side** in `createRsvpSend`, `retryFailedInvitations`, the send route's preview
  `sending.available`, and the queue worker. Each claimed row's organization is re-checked against the
  allowlist; rows of other organizations stay QUEUED.
- **Transport:** in `live` mode, `rsvpTransport()` returns `createResendTransport` (existing fetch-based
  transport, idempotency key and the two allowed headers). The test-outbox path stays for tests.
- **Untouched:** account / security email code (`src/lib/email/index.ts`).
- **Tests:** allowlist refusal, Preview refusal, live mode only with every condition, and no Resend call in
  tests (mocked fetch).

Kill switch (R): unset `RSVP_EMAIL_DELIVERY`, or empty the allowlist, then redeploy. Queued rows stay QUEUED,
nothing is lost, and the counters stay correct. Emails already accepted can't be recalled (I).

## 7. Pilot scope and test scenarios

- **Organizations:** one or two, ideally owned by the operator or a trusted organizer, with fewer than 30
  players. List them in `RSVP_EMAIL_PILOT_ORGS`.
- **Recipients:** first round to internal test addresses only (organizer and staff inboxes), then real
  players who agreed to take part.
- **Allowance:** keep the plan defaults (20 per day / 100 per month for Free). Check the preview's
  "Remaining today / this month" before and after each send.

Scenarios (each with expected result):
1. Preview shows the right eligible and excluded players, with masked addresses and reasons.
2. Send to 2–3 internal addresses: dashboard "Accepted", email received, Yes / Maybe / No links open the page
   with the choice pre-selected, nothing saved until Confirm, the answer appears in attendance.
3. Guardian contact: guardian wording, player name in the body only, not in the subject.
4. Unsubscribe via the page and via Gmail's one-click: the next preview shows "Not receiving invitation
   emails", and resend skips them.
5. Resend to unanswered: answered and overridden players are skipped; the older emailed link reports
   "replaced"; manual links still work.
6. Quota: daily allowance reached → `PLAN_LIMIT` message; the next UTC day resets it.
7. Bounce: send to a known-bad internal address (if Resend allows) → webhook → suppressed → the dashboard
   shows "Suppressed".
8. Telegram match: no email card. Telegram polls unaffected.
9. Account emails (verification, password reset) still arrive during the pilot.

## 8. Retention operation

- Dry run first. `runRsvpRetention({ dryRun: true })` reports `eligible`, `heldForInvestigation`,
  `activeSkipped` and `expiredTokensEligible`, counts only.
- **[APPROVAL]** Then schedule a daily run (for example, added to the existing 15-minute automation cron with
  a once-a-day guard, or a separate daily workflow). Bounded: 500 rows × 20 batches per run. Concurrent runs
  are safe.
- **Incident hold:** set `RsvpSend.retentionHoldUntil` for the affected send before investigating. Remove it
  afterwards.
- **Privacy request from a recipient:** after confirming they control the address, run
  `eraseRecipientEmail(address)` (support-only). It keeps one `RECIPIENT_REQUEST` suppression unless the owner
  decides otherwise. Hard-bounce and complaint suppressions always stay.

## 9. Monitoring and rollback

Daily during the pilot (counts only; no addresses in logs by design):
- the dashboard per pilot match: accepted / failed / uncertain / skipped;
- **any UNCERTAIN** → check Resend logs for that time window before resending;
- cron response `rsvp` counts (`sent`, `failed`, `uncertain`, `errors`, `remaining`), in the GitHub Actions
  log;
- `GlobalEmailSuppression` and `OrganizationEmailOptOut` growth; bounce rate > 2% or **any** complaint →
  pause;
- Resend dashboard: deliverability, bounces, complaints;
- `RsvpEmailUsage` against the allowance.

Rollback ladder:
1. Pause a pilot organization: remove it from the allowlist (R).
2. Stop all RSVP sending: unset `RSVP_EMAIL_DELIVERY` (R). Account email unaffected.
3. Revert the deploy to the previous release (R). The schema stays; old code ignores the new tables.
4. **Not reversible:** emails already accepted (I), anonymized rows (I), applied migrations (I, but additive
   and harmless).

## 10. Go / no-go criteria

**Go only if all are true:**
- [ ] Privacy Policy and Terms changes published (owner-approved).
- [ ] SPF, DKIM and DMARC pass on a test email; the Resend domain is verified; open / click tracking is off.
- [ ] The webhook passes the section 5 procedure in Production.
- [ ] Live-mode code (section 6) is reviewed and merged, with Preview refusal and allowlist tests passing.
- [ ] Migrations applied after a database snapshot; the app is healthy afterwards.
- [ ] Section 7 scenarios 1–4 pass with internal addresses.
- [ ] Retention dry run checked; the schedule is approved.
- [ ] Account email delivery verified unaffected.
- [ ] A named person monitors daily for the pilot's duration, with a written rollback.

**No-go / stop immediately if:**
- any spam complaint;
- bounce rate > 2%;
- an email reaches a non-allowlisted organization's players;
- any address or token appears in logs;
- account emails are delayed;
- UNCERTAIN outcomes repeat without explanation.

## 11. Owner decisions still open

1. Publish the legal changes (and whether to get legal review first).
2. Guardian contacts: whether an organizer's attestation is enough for the pilot, or a guardian
   double-opt-in is needed.
3. Retention period (90 days proposed) and scheduling.
4. Erasure default: keep the address as a `RECIPIENT_REQUEST` suppression (proposed), or forget it.
5. Reply-to address for invitations.
6. DMARC record and policy level.
7. Pilot organizations and duration.
8. Log retention for the one-click unsubscribe URL in Vercel logs (or a log-drain filter).

# M13B — RSVP invitation emails: pilot activation runbook

**Status (P8A.1):** M13B P1–P8A.1 are on `feature/m13b-p1-player-emails`. Nothing is merged, deployed or migrated,
and no real RSVP email has ever been sent. The live transport exists in code but is **off**: no environment has
its flag.

**Every step that changes Production is marked [APPROVAL].** Each one needs its own explicit "yes" from the
owner at the time it is done; approving one step doesn't approve the next.

Reversibility:
- **R** — reversible: turn a switch off or revert a deploy;
- **I** — irreversible: applied migrations, identifiers already removed, emails already delivered.

---

## 1. What exists and its default

| Piece | Default today | Turns on only when |
| --- | --- | --- |
| RSVP delivery mode | `disabled` in every production build; `test-outbox` only in tests and a confirmed local test environment | All live conditions in §5 hold (R) |
| Live transport (Resend) | Unused: no `RSVP_EMAIL_DELIVERY` anywhere | `RSVP_EMAIL_DELIVERY=live-pilot` in **Production**, plus the allowlist, sender and key (R) |
| Organization allowlist | Empty, so nobody can send | `RSVP_EMAIL_PILOT_ORGS` lists 1–10 organization ids (R) |
| Pilot limits | n/a | Live: 20 per organization per UTC day, 100 per organization per month, 100 per UTC day across all organizations. Constants in code (`RSVP_PILOT_LIMITS`); the stricter of plan and pilot applies |
| Send button / API | Disabled (403 `DELIVERY_DISABLED`) | Delivery is allowed for that organization |
| Queue continuation (15-minute cron) | `{ disabled: true }`, claims nothing | Live mode; claims only allowlisted organizations' rows |
| Webhook `/api/email/webhooks/resend` | 503, processes nothing | `RESEND_WEBHOOK_SECRET` is set (R) |
| Retention cleanup | Not scheduled | Owner approves a schedule (§9). Its effect is I |
| Account / security email | Unchanged path (`src/lib/email/index.ts`) | Never affected by any RSVP setting |

**Existing variables can't switch RSVP on.** `EMAIL_TRANSPORT`, `RESEND_API_KEY` and `EMAIL_FROM` alone (as
already set for account email) leave RSVP `disabled`. That is tested.

## 2. Production migration sequence [APPROVAL]

Production is at `f059181`. M13B adds these migrations, all additive, applied in this order by
`prisma migrate deploy`:

1. `20261201120000_m13b_p1_player_contact_email`
2. `20261205120000_m13b_p3_email_suppression`
3. `20261210120000_m13b_p4_rsvp_sending`
4. `20261212120000_m13b_p4_quota_ledger`
5. `20261215120000_m13b_p5_send_attestation`
6. `20261220120000_m13b_p6_delivery_management`
7. `20261225120000_m13b_p7_retention`
8. `20261228120000_m13b_p8a_support_opt_out`
9. `20261230120000_m13b_p8a1_delivery_pacing`

Exact steps:
1. **[APPROVAL]** Create a Neon branch / snapshot of Production named `pre-m13b-<date>`.
2. **[APPROVAL]** Merge the reviewed branch to `main` (code ships with RSVP `disabled`). Let Vercel run the
   project's existing build-time migration procedure, or run `prisma migrate deploy` against Production with
   the documented credentials, per the repository's release process. Never run it from an ad-hoc shell.
3. Verify:
   - `_prisma_migrations` lists all nine;
   - the app's smoke checks pass (sign-in, match page, attendance, Telegram poll);
   - account email still arrives (a password-reset test to an internal address).

Rollback limits:
- **Code** can be reverted (R). The old code ignores the new tables.
- **Migrations** stay (I). Rolling back means a hand-written down-migration from each migration's header.
  Enum values can't be dropped in place.
- **Never drop** `OrganizationEmailOptOut` or `GlobalEmailSuppression`. They are what keeps people who
  unsubscribed, bounced or complained from being emailed again.

## 3. Domain authentication and DMARC [APPROVAL for each DNS change]

Sending domain: `mail.teambalancepro.com` (the only RSVP sender domain the code accepts).

1. In Resend → Domains, open `mail.teambalancepro.com`. If it isn't verified, add exactly the records Resend
   shows **[APPROVAL]**:
   - SPF: the `TXT` / `MX` records on the bounce subdomain Resend specifies;
   - DKIM: the `TXT` record(s) Resend specifies.

   Wait until Resend shows **Verified**.
2. **DMARC (currently missing — blocker) [APPROVAL]:** add `_dmarc.teambalancepro.com` (or
   `_dmarc.mail.teambalancepro.com`):
   `v=DMARC1; p=none; rua=mailto:<monitored address>; adkim=r; aspf=r`.
   Watch the aggregate reports for at least 7 days before moving to `p=quarantine`.
3. Send one account email (password reset) to an internal Gmail address and open "Show original". It must
   show `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`.
4. In Resend, check that **open and click tracking are OFF** for this domain. Click tracking would rewrite
   the `/attend?c=…#token` links.

## 4. Resend quota verification [APPROVAL if the plan changes]

1. In the Resend dashboard, note the plan's daily and monthly sending limits and its rate limit.
2. The pilot's worst case is **100 RSVP emails per UTC day** (the pilot-wide cap), plus account email. Check
   that the plan's daily limit is at least 2× that worst case, so account email is never squeezed out.
3. If it isn't, change the plan **[APPROVAL]**, or keep fewer pilot organizations.

## 5. Feature flags and allowlist [APPROVAL]

The live mode requires **all** of these in Vercel → Project → Settings → Environment Variables, scoped to
**Production only** (never Preview or Development):

| Variable | Value | Notes |
| --- | --- | --- |
| `RSVP_EMAIL_DELIVERY` | `live-pilot` (exact) | Any other value means disabled |
| `RSVP_EMAIL_PILOT_ORGS` | `<orgId>[,<orgId>…]` (1–10 cuid ids) | One malformed entry disables the whole pilot |
| `RESEND_API_KEY` | already set for account email | Unchanged |
| `EMAIL_FROM` | `TeamBalance Pro <noreply@mail.teambalancepro.com>` | Must be a display name on `mail.teambalancepro.com` |
| `APP_BASE_URL` | `https://teambalancepro.com` | Already set |
| `VERCEL_ENV` | `production` (set by Vercel) | Preview deployments can never be live |

Steps:
1. Get the pilot organization ids (read-only query, or the admin URL) and confirm them with the owner.
2. **[APPROVAL]** Add `RSVP_EMAIL_PILOT_ORGS` (Production).
3. **[APPROVAL]** Add `RSVP_EMAIL_DELIVERY=live-pilot` (Production).
4. **[APPROVAL]** Redeploy Production (variables apply on deploy).
5. Check: a pilot organizer's match page shows the Send button enabled; a non-pilot organization's shows
   "coming soon"; a Preview deployment shows "coming soon".

## 6. Webhook (bounces and complaints) [APPROVAL]

1. **[APPROVAL]** In Resend → Webhooks, add the endpoint `https://teambalancepro.com/api/email/webhooks/resend`
   with events **`email.bounced`** and **`email.complained`** only.
2. Copy the signing secret (`whsec_…`). **[APPROVAL]** Set `RESEND_WEBHOOK_SECRET` (Production only), then
   redeploy.
3. Check the endpoint is reachable but refuses unsigned calls:
   `curl -s -o /dev/null -w "%{http_code}" -X POST https://teambalancepro.com/api/email/webhooks/resend -d '{}'`
   must print `401` (`503` means the secret isn't deployed).
4. **Authentic signed event.** If the Resend dashboard offers a test event for the endpoint, send it.
   Otherwise, once live (§5), send one RSVP invitation from a pilot organization to Resend's documented bounce
   test address (`bounced@resend.dev`; confirm it in Resend's current docs).
5. **Expect:**
   - Resend's delivery log for the endpoint shows HTTP 200 with
     `{"ok":true,"status":"processed","outcome":"SUPPRESSED"}`;
   - one `EmailWebhookEvent` row (provider, event id, type `email.bounced`, outcome `SUPPRESSED`);
   - one `GlobalEmailSuppression` row (`HARD_BOUNCE`, source `resend-webhook`).
6. **Complaint:** repeat with `complained@resend.dev`. Expect `SPAM_COMPLAINT`.
7. **Duplicates:** use "Resend" / replay on the same event in the dashboard. Expect HTTP 200 with
   `"status":"duplicate"` and no new rows.
8. **Payload check:** compare the real payload fields (`type`, `data.to[]`, `data.bounce.type`) with the
   handler. If they differ, **stop** and fix the handler before relying on it.
9. **Monitoring:**
   - Resend's endpoint page shows failed deliveries and retries;
   - our logs only ever contain `[email-webhook] processing failed`, with no ids or addresses;
   - any 5xx from the endpoint → investigate the same day;
   - repeated 401s → check the secret wasn't rotated without a redeploy.
10. Delete the test suppression rows for `bounced@resend.dev` / `complained@resend.dev` afterwards
   **[APPROVAL]** (one SQL statement, logged).

Rollback (R): disable the endpoint in Resend and unset `RESEND_WEBHOOK_SECRET` (it answers 503 again).

## 7. Prerequisites before the first real invitation (go / no-go)

- [ ] Privacy Policy and Terms changes published **[APPROVAL]**. Drafts:
      `docs/legal/privacy-policy-m13b-draft.md`, `docs/legal/terms-m13b-draft.md`. Open decisions settled.
- [ ] §3 passes: SPF, DKIM and DMARC pass; the domain is verified; tracking is off.
- [ ] §4 quota is confirmed.
- [ ] §2 migrations are applied, with a snapshot taken.
- [ ] §6 webhook is verified with an authentic signed event.
- [ ] The retention schedule is approved (§9).
- [ ] A named person monitors daily for the whole pilot (§10).

**No-go / stop at once** (§11):
- any spam complaint;
- bounce rate over 2%;
- an email to a non-allowlisted organization's players;
- an address or token in logs;
- delayed account email;
- repeated unexplained UNCERTAIN results.

## 8. Pilot test cases (one or two organizations, internal addresses first)

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Preview a match | Correct eligible / excluded players, masked addresses and reasons; "Remaining today / this month" shows pilot limits (at most 20 / 100) |
| 2 | Send to 2–3 internal addresses | Dashboard "Accepted by email provider"; email arrives; From is `TeamBalance Pro <noreply@mail.teambalancepro.com>`; the subject has no personal data |
| 3 | Yes / Maybe / No links | The page opens with the choice pre-selected; nothing is saved until Confirm; attendance updates |
| 4 | Guardian contact | Guardian wording; player name only in the body |
| 5 | Gmail one-click unsubscribe and the page unsubscribe | The next preview shows "Not receiving invitation emails"; resend skips them |
| 6 | Resend to unanswered | Answered and overridden players skipped; the older emailed link says "replaced"; manual links still work |
| 7 | Daily limit | The 21st recipient in a day gets `LIMIT`; a send with none left gets `PLAN_LIMIT`; it resets at 00:00 UTC |
| 8 | Non-pilot organization | Send disabled (403 `DELIVERY_DISABLED`) |
| 9 | Bounce / complaint (§6) | Suppressed globally; the dashboard shows "Suppressed" |
| 10 | Account email during the pilot | Verification and password reset still arrive |
| 11 | Telegram match | No email card; polls unaffected |

## 9. Retention and privacy requests

- **Retention** (`runRsvpRetention`): **removes direct identifiers**. It does not anonymize (see
  `docs/M13B_RSVP_EMAIL.md`, P8A).
  1. Run with `{ dryRun: true }` first and read the counts.
  2. **[APPROVAL]** Schedule it daily (for example, a once-a-day guard in the existing automation cron, or a
     separate daily workflow).
  3. Incident hold: set `RsvpSend.retentionHoldUntil` for the affected send.
- **Privacy request** from a recipient (support only, after checking they control the address):
  `eraseRecipientEmail(address, { scope, doNotContact })`.
  - `scope` is `{ kind: "ALL" }` or `{ kind: "ORGANIZATION", organizationId }`.
  - `doNotContact` must be chosen explicitly:
    - `"NONE"`: delete only;
    - `"ORGANIZATION"`: a support-recorded opt-out for that organization;
    - `"GLOBAL"`: a do-not-contact for every organization, used only if the recipient asks for it.
  - Existing opt-outs stay organization-scoped and are never removed or converted. Bounce, complaint and
    earlier do-not-contact records are never removed.

## 10. Monitoring (daily during the pilot; logs carry counts only)

- Dashboard per pilot match: accepted / failed / uncertain / skipped. **Any UNCERTAIN** → check Resend's logs
  for that window before resending.
- GitHub Actions automation log: the `rsvp` counts (`sent`, `failed`, `uncertain`, `rateLimited`, `errors`,
  `remaining`, `stoppedForProvider`, `stoppedForTime`).
  - `stoppedForProvider` on two runs in a row → check Resend's status page and logs.
  - Any `rateLimited` → check the Resend plan and the account email volume.
- Resend dashboard: bounces, complaints, delivery rate, webhook failures.
- Database (read-only): growth of `GlobalEmailSuppression` / `OrganizationEmailOptOut`, and today's
  `RsvpEmailUsage` against the 100-per-day pilot cap.
- Vercel logs: search for `rsvp` / `email` errors. They should never contain an address or token.

## 11. Emergency disablement (fastest first)

1. **Pause one organization:** remove it from `RSVP_EMAIL_PILOT_ORGS` and redeploy (R). Its queued rows stay
   QUEUED and aren't claimed.
2. **Stop all RSVP email:** delete `RSVP_EMAIL_DELIVERY` and redeploy (R). Sends, retries and the cron are
   refused or report `disabled`. Account email is unaffected.
3. **Bad deploy:** promote the previous Production deployment in Vercel (R).
4. **Webhook trouble:** disable the endpoint in Resend (R).

Not reversible (I):
- emails Resend already accepted;
- identifiers removed by retention or erasure;
- applied migrations (additive and harmless).

After an emergency: write down what happened. If it was a delivery incident, put an incident hold on the
affected sends before investigating.

## 12. Owner decisions (all open)

1. Publish the Privacy Policy and Terms changes; get legal review first (recommended)?
2. Guardian contacts: is the organizer's attestation enough for the pilot, or is a guardian double opt-in
   required?
3. Retention: 90 days after the match (proposed); approve the daily schedule.
4. Privacy requests: who verifies identity, and how. Default `doNotContact` when a requester doesn't say:
   proposed `"NONE"`, but ask them.
5. Reply-to address for invitations (none today).
6. DMARC record and policy level.
7. Pilot organizations (1–2), start date and duration.
8. Log retention for the one-click unsubscribe URL in Vercel request logs.
9. Approve each [APPROVAL] step above, at the time it is done.

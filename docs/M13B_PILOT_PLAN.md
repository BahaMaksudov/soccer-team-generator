# M13B — staff-only RSVP email pilot plan

**Owner decision (P8B.2a):** a **staff-only** pilot. No organization is created or changed by this document.
Every Production action follows `docs/M13B_PILOT_READINESS.md` and `docs/M13B_DEPLOYMENT_SAFETY.md`, and
needs its own **[APPROVAL]**.

## 1. Pilot organization (staff only)

**Why a dedicated organization:** a send emails **every eligible player on the match roster**. That includes
players reachable through their own verified linked account, and there is no per-recipient selection. An
existing organization with real players must **not** be used.

- **One new, dedicated internal organization,** created by the owner in the normal app (for example "TeamBalance
  Staff Pilot") **[APPROVAL]**. Its roster contains **only approved staff testers**.
- **One group, one upcoming test match,** website attendance only: no Telegram chat or poll.
- **Recipients:**
  - three to start, at most five during initial testing;
  - every address is the owner's own or a consenting staff tester's;
  - each is entered as a **Player**-type contact with the confirmation ticked, or reached through the tester's
    own verified linked account.
- **No real players, no guardian contacts** (no Parent / Guardian type at all), no external organizations.
- **Allowlist:** `RSVP_EMAIL_PILOT_ORGS=<that organization id>` only.
- **Before the first send, the invitation preview must show exactly three "Will be invited".** Every other
  roster entry, if any, must be excluded with a visible reason. If the count isn't exactly three, **don't
  send**.
- **Staff testers are still data subjects.** Tell them what is stored (address, delivery status, answers), the
  90-day retention, and how to unsubscribe or ask for deletion; get their consent first.

## 2. Observation window: 7 days

| Day | Action | Batch |
| --- | --- | --- |
| 0 | Enable (runbook §5); check the preview shows **exactly 3**; send an INITIAL invitation to the **3 staff recipients** | 3 |
| 0 | Run test cases 1–3 and 10 from runbook §8 (no guardian case 4; unsubscribe case 5 comes last) | — |
| 1 | Resend to unanswered (test case 6); check the "replaced" link | ≤ 3 |
| 2 | Optional, **only with explicit approval** (not staff addresses): bounce and complaint checks with `bounced@resend.dev` / `complained@resend.dev` (runbook §6), then clean up | 2 |
| 3–6 | Optionally add staff testers 4–5; normal use on one more test match | ≤ 5 per day |
| last | **Unsubscribe test.** Run it last, or on a separate approved test address. An opt-out is permanent: no code can remove it, and lifting it needs a separately approved manual SQL statement | 1 |
| 7 | Review: extend / expand / roll back | — |

Hard limits during the pilot: the code caps it at 20 per organization per day and 100 across the pilot. The
plan stays far below that.

## 3. Daily monitoring (owner, about 10 minutes per day)

**Named monitoring owner:** _(the owner to name a person; proposed: the account owner)_, with a backup.

Each day check:
1. **Match dashboard:** accepted / failed / uncertain / skipped. Any **UNCERTAIN** → look up that recipient in
   Resend's logs before any resend.
2. **GitHub Actions automation log, `rsvp` counts:**
   - `stoppedForProvider` twice in a row → check Resend's status;
   - any `rateLimited` → check the plan and quota;
   - `errors` > 0 → check Vercel logs, which contain no addresses.
3. **Resend dashboard:** delivered, bounced and complained counts; webhook delivery failures.
4. **Read-only query [APPROVAL to connect]:** today's `RsvpEmailUsage` total and new `GlobalEmailSuppression`
   / `OrganizationEmailOptOut` rows.
5. **Account email spot check** on days 0 and 7 (password reset to an internal address).

## 4. Thresholds

| Signal | Threshold | Action |
| --- | --- | --- |
| Spam complaint | **any 1** | Stop at once (§5, step 2); investigate |
| Hard bounces (excluding the planned test) | > 2% of sent, or any unexpected | Pause the organization (§5, step 1); fix the contacts |
| UNCERTAIN | > 1 unexplained in a day | Pause; check Resend's logs |
| `stoppedForProvider` | 3 runs in a row | Pause; check the provider |
| Account email delay | any | Stop RSVP (§5, step 2) |
| An email to a non-allowlisted organization | any | Stop; this would be a defect |
| An address or token in logs | any | Stop; this would be a defect |

## 5. Emergency kill switch (fastest first)

1. **Pause the organization:** remove its id from `RSVP_EMAIL_PILOT_ORGS`, then redeploy **[APPROVAL]**.
   Queued emails wait; nothing is lost.
2. **Stop all RSVP email:** delete `RSVP_EMAIL_DELIVERY`, then redeploy **[APPROVAL]**. Sends and the cron
   stop handing off; account email is unaffected.
3. **Promote the previous Production deployment** in Vercel **[APPROVAL]**.
4. **Webhook problems:** disable the endpoint in Resend **[APPROVAL]**.

Emails already accepted by Resend can't be recalled.

## 6. Criteria after day 7

**Expand** to one or two real organizations (an organizer who agrees, at most 30 players) only if **all**
hold:
- 0 complaints, and no unexpected bounces;
- 0 unexplained UNCERTAIN;
- every test case passed;
- account email was unaffected;
- no defect found;
- the legal changes are published (before any non-staff recipient).

**Extend the internal pilot by 7 days** if there were minor issues that were fixed, such as a contact typo or
a rendering tweak.

**Roll back (kill switch, step 2)** if any stop threshold was hit and the cause isn't understood, or on any
defect involving recipient data, allowlisting or account email.

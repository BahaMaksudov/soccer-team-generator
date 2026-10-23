# M13B — proposed RSVP email pilot plan

**Proposal for owner approval.** No organization is created or changed by this document. Every Production
action follows `docs/M13B_PILOT_READINESS.md` and needs its own **[APPROVAL]**.

## 1. Pilot organization

- **One internal organization:** an existing organization the owner runs, or a new "TeamBalance Pilot"
  organization created by the owner in the normal UI **[APPROVAL]**.
- **One group, one upcoming match,** website attendance (not Telegram).
- **Roster:** 3–5 players whose addresses belong to staff or consenting friends. At least one is a
  guardian-type contact (an internal address marked Parent / Guardian), and at least one uses a linked
  verified account.
- **Allowlist:** `RSVP_EMAIL_PILOT_ORGS=<that organization id>` only.

## 2. Observation window: 7 days

| Day | Action | Batch |
| --- | --- | --- |
| 0 | Enable (runbook §5); send an INITIAL invitation for match 1 to **3 internal recipients** | 3 |
| 0 | Run test cases 2–6 and 10 from runbook §8 | — |
| 1 | Resend to unanswered (test case 6); check the "replaced" link | ≤ 3 |
| 2 | Bounce and complaint checks with `bounced@resend.dev` / `complained@resend.dev` (runbook §6), then clean up | 2 |
| 3–6 | One more match; normal use by the organizer; up to **10 recipients per day** | ≤ 10 per day |
| 7 | Review: go / expand / roll back | — |

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

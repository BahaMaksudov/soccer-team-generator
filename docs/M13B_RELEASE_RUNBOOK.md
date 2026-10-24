# M13B — Production release runbook

**One ordered procedure.** Every step marked **[APPROVAL]** changes Production or Preview and needs the owner's
explicit go-ahead. RSVP email stays **disabled** throughout: `RSVP_EMAIL_DELIVERY` is never set by this runbook.

Release: `feature/m13b-p1-player-emails` → `main`. This is a fast-forward: `f059181` is an ancestor of the release commit.

Systems:
- Vercel project `soccer-team-generator` (build command `npx prisma migrate deploy && npm run build`);
- Neon project `spring-firefly-39638969`:
  - Production: branch `br-red-forest-ad3rdurr`, endpoint `ep-misty-butterfly-adm5suti`;
  - Preview: endpoint `ep-bitter-sea-ado8dcov`;
- DNS at Vercel;
- Resend.

---

## A. Preview isolation — DONE (read-only, verified)

The Prisma `Datasource` line in the build logs:
- Production deployment `dpl_2graEedKFrzZ1KskCcXr8zNLkB5Q` → `ep-misty-butterfly-adm5suti`;
- Preview deployments `dpl_5hkPKPQTQg3aSH2g11WLYDx2r1wV` (2026-10-22) and
  `dpl_59adCnSZz5gGjP7PN4Qu8WxVsJem` → `ep-bitter-sea-ado8dcov`.

Neither `DATABASE_URL` entry has changed since 2026-10-03. Preview builds run migrations, so they use a
read-write endpoint, and Neon allows only one read-write endpoint per branch. **The Preview branch is therefore
separate from Production.**

Consequence: pushing the feature branch triggers a Preview build that migrates **only** the Preview database. That
is a useful dress rehearsal on a Production clone.

## B. DMARC [APPROVAL]

1. Vercel → Domains → `teambalancepro.com` → DNS Records → Add:
   - Name `_dmarc`;
   - Type `TXT`;
   - Value `v=DMARC1; p=none; adkim=r; aspf=r`;
   - TTL: the default.
2. Verify:
   - `dig +short TXT _dmarc.teambalancepro.com @ns1.vercel-dns.com`, then the same with `@1.1.1.1` and
     `@8.8.8.8` → `"v=DMARC1; p=none; adkim=r; aspf=r"`.
3. Alignment check:
   1. Request a password reset for an owner Gmail address.
   2. Open "Show original" → `SPF: PASS` (`send.mail.teambalancepro.com`), `DKIM: PASS`
      (`mail.teambalancepro.com`), `DMARC: PASS`.
4. **Rollback:** delete the TXT record.

Effect: monitoring only (`p=none`), so no delivery change for account email. Add `rua=` later, once a
reporting mailbox exists.

## C. Neon pre-M13B recovery branch [APPROVAL]

Neon console → project `spring-firefly-39638969` → Branches → **New branch**:
- parent `br-red-forest-ad3rdurr`;
- **Head**;
- name `pre-m13b-<YYYYMMDD-HHMM>Z`;
- **no compute**, or read-only compute only.

Record the branch id, the creation time (UTC) and the LSN.

## D. Verify the recovery branch (read-only)

On that branch (Neon SQL editor, or a temporary read-only compute):

```sql
SELECT count(*) FROM "_prisma_migrations";                                         -- expect 40
SELECT count(*) FROM "_prisma_migrations" WHERE migration_name ILIKE '%m13b%';      -- expect 0
SELECT max(migration_name) FROM "_prisma_migrations";                               -- expect 20261125120000_m13a_group_join
SELECT count(*) FROM information_schema.tables WHERE table_name = 'RsvpInvitation'; -- expect 0
SELECT count(*) FROM "Player";                                                      -- ≈ current (40 at audit)
```

**Proceed only if all match.**

## E. Deploy M13B (RSVP delivery stays absent) [APPROVAL]

1. Optional rehearsal (recommended):
   1. `git push origin feature/m13b-p1-player-emails`. The Preview build migrates `ep-bitter-sea-ado8dcov` only.
   2. Check the Preview build log: `10 migrations found … All migrations have been successfully applied` and
      `Datasource … ep-bitter-sea-ado8dcov`.
   3. Do a quick click-through on the Preview URL.
2. Release:
   1. `git checkout main && git merge --ff-only feature/m13b-p1-player-emails && git push origin main`.
   2. Vercel builds Production. The migrations run before the new deployment goes live, while `f059181` keeps
      serving.
3. **Do not** set `RSVP_EMAIL_DELIVERY`, `RSVP_EMAIL_PILOT_ORGS` or `RSVP_RETENTION_MODE` yet.

## F. Verify the ten migrations

- **Build log** (read-only): `Datasource … ep-misty-butterfly-adm5suti`, then `50 migrations found` and the ten
  `m13b` migrations applied, then `Compiled successfully`, then READY.
- Optional, read-only SQL (approved metadata query):
  `SELECT count(*) FILTER (WHERE migration_name ILIKE '%m13b%' AND finished_at IS NOT NULL), count(*) FILTER (WHERE finished_at IS NULL) FROM "_prisma_migrations";`
  → `10 | 0`.

**If the build fails after migrations:** `f059181` keeps serving and is compatible with the migrated schema
(all changes are additive). Fix and redeploy. **Don't restore** (see `docs/M13B_DEPLOYMENT_SAFETY.md` §1).

## G. Smoke tests (owner, on teambalancepro.com)

| Area | Check |
| --- | --- |
| Sign-in | Password and Google sign-in; `/me` loads |
| Matches | Open a group's match page. The new "Email invitations" card shows **"Send invitations — coming soon"** (disabled) |
| Attendance | On a **test match**: change an answer through the organizer view, and through a personal link (the page shows the choice buttons; nothing saves until a tap or Confirm) |
| Team generation | Generate teams for a test match (publishing is optional) |
| Telegram | Existing poll results still display. **No new poll needs to be posted** for this check; posting one is a real Telegram message, so do it only if wanted |
| Account email | A password reset to an owner address arrives (with no unsubscribe header) |
| Cron | The next GitHub Actions "match-automation" run is green; its response shows `rsvp: {disabled: true}` and `retention: {disabled: true}` |

**Rollback:** Vercel → promote `dpl_2graEedKFrzZ1KskCcXr8zNLkB5Q` (`f059181`) **[APPROVAL]**. No database
action.

## H. Resend webhook [APPROVAL]

1. Resend → Webhooks → Add endpoint:
   - URL `https://teambalancepro.com/api/email/webhooks/resend`;
   - events **`email.bounced`** and **`email.complained`** only.
2. Copy the signing secret (`whsec_…`) **directly** into Vercel → Settings → Environment Variables:
   - `RESEND_WEBHOOK_SECRET`;
   - **Production only**;
   - type **Sensitive**.

   Never paste it anywhere else.
3. Redeploy Production (no code change; migrations: "No pending migrations").

## I. Verify the webhook (no RSVP invitation sent)

1. `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://teambalancepro.com/api/email/webhooks/resend -d '{}'`
   → **401**. That proves the secret is loaded and unsigned calls are refused; 503 would mean the secret is
   missing.
2. Authentic signed event, choose one **[APPROVAL]**:
   - Resend's endpoint test / replay, if the dashboard offers it;
   - **or** a real bounce through *account* email: sign up with `bounced@resend.dev` (a Resend simulator inbox,
     not a person). The verification email bounces.

   Either way, expect Resend's delivery log for the endpoint to show 200 with `"status":"processed"`, and one
   `HARD_BOUNCE` suppression for that address.
3. Duplicate: use "Resend" on the same event → 200 with `"status":"duplicate"` and no new rows.
4. Afterwards **[APPROVAL]**: delete the simulator suppression row and the throwaway user, if created.

## J. Retention schedule [APPROVAL]

1. Set `RSVP_RETENTION_MODE=dry-run` (Production) and redeploy. The cron's `retention` counts appear on every
   run. Expected now: `eligible: 0`, `identifiersRemoved: 0`, since no invitations exist yet.
2. After at least one clean dry run, set `RSVP_RETENTION_MODE=run` and redeploy. It acts on **every** authorized
   cron run. There is no time window, because GitHub's schedule is irregular. That's safe: the job is idempotent
   (only rows past the 90-day cutoff that aren't cleaned yet), bounded per run, and a concurrent run stops.
3. **Rollback:** delete `RSVP_RETENTION_MODE` (off) and redeploy. Identifiers already removed stay removed.

## K. Confirm live RSVP delivery stays disabled

- Vercel env (names only): `RSVP_EMAIL_DELIVERY` and `RSVP_EMAIL_PILOT_ORGS` **absent**.
- The match-page card shows "coming soon".
- Cron `rsvp: {disabled: true}`.
- A POST to the send endpoint would return 403 `DELIVERY_DISABLED`; that's enforced in code and tested.

**Activating the staff pilot is a separate, later approval** (`docs/M13B_PILOT_PLAN.md`, steps 7–9 of
`docs/M13B_DEPLOYMENT_SAFETY.md` §6).

# M13B — Production pre-deployment safety (P8B.3)

**Preparation only.** Nothing in this document has been executed. Every Production-changing step is marked
**[APPROVAL]** and needs the owner's explicit, separate authorization at the time it is done.

Evidence labels:
- **[VERIFIED]**: checked directly. The P8B.2b audit (read-only, against Production, deployment
  `dpl_2graEedKFrzZ1KskCcXr8zNLkB5Q` at `f059181`) or the repository.
- **[OWNER-REPORTED]**: the owner checked it manually and reported it as fine; not independently verified.
- **[UNVERIFIED]**: not established by either.

---

## 1. When migrations run, and against which database

**[VERIFIED]** The Vercel project `soccer-team-generator` has the build command
`npx prisma migrate deploy && npm run build`. Production branch: `main`. No Neon integration.

So **every Vercel build first applies all pending migrations to the database in that build's `DATABASE_URL`,
then builds the app.**
- Migrations run during the **build step**, before the new deployment receives traffic.
- The deployment currently serving keeps serving throughout the build.

| Action | Triggers a build? | Environment / `DATABASE_URL` used | What is migrated |
| --- | --- | --- | --- |
| Push `feature/m13b-p1-player-emails` to GitHub | **Yes**: a Preview build (Vercel builds every pushed branch by default) [VERIFIED: earlier Preview deployments exist for feature branches] | The **Preview**-scoped `DATABASE_URL` (a separate variable entry, "sensitive") [VERIFIED] | All ten M13B migrations, applied to **whatever database the Preview URL points to** |
| Open / update a PR | Same Preview build as a push | Preview | Same |
| Merge to `main` | **Yes**: a Production build | The **Production**-scoped `DATABASE_URL` → Neon `spring-firefly-39638969` / branch `br-red-forest-ad3rdurr` / endpoint `ep-misty-butterfly-adm5suti` [VERIFIED] | All ten M13B migrations on **Production** |
| Redeploy / promote an existing deployment | Redeploy builds again; promote doesn't | As above | Only migrations still pending |

**Preview isolation is the first gate.**
- **[OWNER-REPORTED]** Neon "looks good".
- **[UNVERIFIED]** Whether Preview's `DATABASE_URL` points to a branch other than `br-red-forest-ad3rdurr`. Its
  value is "sensitive" and can't be read back. Earlier phases recorded a Neon branch named `vercel-preview`.
- **If Preview pointed at Production, a branch push would migrate Production before any merge decision.**
- **Required before pushing [APPROVAL]:** in the Neon console, confirm the Preview environment's host / branch is
  not `ep-misty-butterfly-adm5suti` / `br-red-forest-ad3rdurr`.
  - Alternative: don't push the feature branch; merge locally into `main` and push only `main` (Production
    deploy), after the snapshot.

### Failure scenarios

| Scenario | What happens | Production impact | Recovery |
| --- | --- | --- | --- |
| Migrations succeed, `next build` fails | The build fails; the new deployment never goes live; `f059181` keeps serving on the **migrated** schema | **None expected.** All ten migrations are additive and the old code works with them [VERIFIED by analysis]: new tables are ignored; new `Player` / `RsvpSend` / `RsvpInvitation` columns are nullable; `PersonalAttendanceLink.channel` has a default (`MANUAL`) that old inserts get automatically; the `Player` CHECKs hold for rows that leave the new columns empty (old code never sets them); the new foreign keys are SET NULL / CASCADE and only point *from* new columns or tables | Fix the build on the branch and redeploy. **No database action.** Don't restore. |
| A migration fails partway | `prisma migrate deploy` stops; earlier migrations stay applied; the failed one is recorded as failed in `_prisma_migrations`; the build fails; the old deployment keeps serving | The old code is unaffected (additive); **later deploys are blocked** until the failure is resolved | Read-only: inspect `_prisma_migrations`. Prisma applies each PostgreSQL migration in a transaction, so a failed migration should leave no partial changes **[ASSUMPTION; confirm the actual schema state read-only]**. Then **[APPROVAL]** `prisma migrate resolve --rolled-back <name>`, fix, redeploy |
| Build succeeds, the new deployment misbehaves | The new code is live; RSVP delivery stays **disabled** (no `RSVP_EMAIL_DELIVERY`) [VERIFIED] | Possible regression in existing features | **[APPROVAL]** Vercel → promote the previous deployment `dpl_2graEedKFrzZ1KskCcXr8zNLkB5Q` (`f059181`), which works on the migrated schema (row 1). No database action |
| Concurrent builds (Preview + Production) | Each targets its own database; Prisma takes an advisory lock per database during `migrate deploy` | None, if Preview is isolated | — |

Notes:
- Production has had a failed build before (`dpl_2ijgmBNok2DB6F1NZeQF27MZaU57`, `032413e`, ERROR)
  [VERIFIED]. Row 1 of the failure table is a realistic case.
- Lock impact on Production [VERIFIED counts]: `Player` 40 rows / 96 kB and `PersonalAttendanceLink` 6 rows /
  80 kB, so the CHECK-constraint and foreign-key locks take milliseconds. PostgreSQL is 17.11.

## 2. Backup and recovery plan (Neon) — nothing created yet

Facts:
- **[VERIFIED]** Production is project `spring-firefly-39638969`, branch `br-red-forest-ad3rdurr`, with 40
  migrations, the newest `20261125120000_m13a_group_join`, and 0 M13B tables.
- **[OWNER-REPORTED]** Neon recovery "looks good".
- **[UNVERIFIED]** The exact point-in-time restore (history retention) window, and the plan's branch limits.

### 2.1 Snapshot before the merge [APPROVAL]
1. Neon console → project `spring-firefly-39638969` → Branches → **Create branch**:
   - parent `br-red-forest-ad3rdurr`;
   - **from "Head" (now)**;
   - name `pre-m13b-<YYYYMMDD-HHMM>Z`;
   - **no compute endpoint**, or a suspended one, so it costs nothing and nobody can write to it.
2. Write down the **recovery point**: the new branch id, its creation timestamp (UTC) and the parent LSN shown by
   Neon. Also record the Production deployment id (`dpl_2graEedKFrzZ1KskCcXr8zNLkB5Q`) and the SHA
   (`f059181`).
3. Read-only verification of the snapshot (temporary read-only endpoint, or Neon's SQL editor on that branch):
   - `SELECT count(*) FROM "_prisma_migrations";` → **40**
   - `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name ILIKE '%m13b%';` → **0**
   - `SELECT count(*) FROM "Player";` → **40** (or the current value at that time)
   - `SELECT count(*) FROM information_schema.tables WHERE table_name = 'RsvpInvitation';` → **0**
4. Then merge within the same session, so the recovery point is minutes old.

### 2.2 Restore verification drill (optional, recommended once) [APPROVAL]
- Create a throwaway branch from the snapshot with a temporary endpoint and run the four queries above.
- Run any Prisma migration against **that throwaway branch only**, never Production, to rehearse:
  `prisma migrate deploy` with its URL. Expect ten migrations applied, then
  `prisma migrate diff --exit-code` = 0.
- Delete the throwaway branch afterwards.

### 2.3 Rollback choices, least drastic first
1. **Code rollback (preferred):** promote `f059181` in Vercel **[APPROVAL]**. The schema stays migrated, and the
   old code is compatible (§1).
2. **Fix forward:** a corrective migration and deploy.
3. **Database restore (last resort) [APPROVAL]:** Neon "Restore" of `br-red-forest-ad3rdurr` to the snapshot
   or a point in time.
   - **Every write after the recovery point is lost:** sign-ups, attendance answers, match edits, Telegram
     poll answers and, once live, RSVP opt-outs.
   - Requires downtime, and a redeploy of the matching code (`f059181`).
   - Only for real data corruption, never just to undo additive schema changes.

### 2.4 Keeping suppression and unsubscribe records once RSVP is live
Opt-outs and suppressions are what keep people from being emailed again. **They must survive any database
recovery.**
- **Never drop** `OrganizationEmailOptOut` or `GlobalEmailSuppression` (repeated from the runbook).
- **Before any restore** to a point earlier than "now" after RSVP went live:
  1. **[APPROVAL]** Export the current rows of both tables, read-only `COPY … TO STDOUT`, into encrypted owner
     storage. The rows hold addresses: handle them as personal data, keep them only as long as the restore takes,
     then delete the export.
  2. After the restore, **[APPROVAL]** re-insert them with `ON CONFLICT DO NOTHING` (unique on address, or on
     organization + address).
  3. Then run a reconciliation count.
- `RsvpEmailUsage` (quota) can be rebuilt approximately from Resend's logs. Losing it only affects allowance
  counting.

## 3. DMARC (not changed)

**[VERIFIED]** No DMARC record exists: `_dmarc.teambalancepro.com` returns no TXT, and
`_dmarc.mail.teambalancepro.com` returns NXDOMAIN. DNS is hosted by Vercel (`ns1/ns2.vercel-dns.com`).

**Proposed record [APPROVAL]** (Vercel → Domains → `teambalancepro.com` → DNS records → Add):

| Name | Type | Value | TTL |
| --- | --- | --- | --- |
| `_dmarc` | TXT | `v=DMARC1; p=none; adkim=r; aspf=r` | 3600 (or the default) |

- **Reports are added later.** Append `; rua=mailto:<mailbox>` only after confirming that mailbox exists and can
  receive the volume of aggregate reports.
- **If the mailbox is on another domain:** that domain must publish an authorization record
  (`teambalancepro.com._report._dmarc.<that domain>`).

**What it does:**
- It publishes a DMARC policy for `teambalancepro.com` and its subdomains (`sp` defaults to `p`), including
  `mail.teambalancepro.com`, the From domain.
- `p=none` means **monitor only**: receivers don't reject or quarantine because of it.
- `adkim=r; aspf=r` allows relaxed alignment, so organizational-domain matches count.

**Effect on existing account email:**
- **No delivery change expected.** `p=none` doesn't instruct receivers to block anything.
- Current account emails already authenticate and align, which is expected to give `DMARC: PASS`, which some
  providers (for example, Gmail's bulk-sender rules) look for:
  - **DKIM:** `d=mail.teambalancepro.com` (key at `resend._domainkey.mail.teambalancepro.com` [VERIFIED]).
    Aligned with the From domain `mail.teambalancepro.com`.
  - **SPF:** the envelope / Return-Path domain is `send.mail.teambalancepro.com` (`v=spf1 include:amazonses.com
    ~all`, MX `feedback-smtp.us-east-1.amazonses.com` [VERIFIED]). Relaxed alignment with
    `teambalancepro.com`.
- **Other mail claiming `@teambalancepro.com`** (for example, anything sent from the root domain through other
  services) is also covered. Under `p=none` nothing is blocked. Review that before ever tightening the policy.

**DNS note:**
- **[VERIFIED]** A wildcard address record answers for unknown subdomains (for example, `_dmarc` returned
  A-type IPs).
- An explicit `_dmarc` TXT record takes precedence for that name. A-record lookups for `_dmarc` would then
  return no data, which is harmless.

**Check propagation:**
- `dig +short TXT _dmarc.teambalancepro.com @ns1.vercel-dns.com` (authoritative);
- `dig +short TXT _dmarc.teambalancepro.com @1.1.1.1` and `@8.8.8.8` (public resolvers; allow up to the TTL).

Each must return `"v=DMARC1; p=none; adkim=r; aspf=r"`.

**Check alignment:**
1. Request a password reset for an internal Gmail account.
2. Open the email → ⋮ → **Show original**. Expect `SPF: PASS` (with domain `send.mail.teambalancepro.com`),
   `DKIM: PASS` (with domain `mail.teambalancepro.com`) and `DMARC: PASS`.
3. Optionally repeat in Outlook.com (message source: `Authentication-Results` header).

**Roll back:** delete the `_dmarc` TXT record in Vercel DNS **[APPROVAL]**. Receivers stop seeing it after the
TTL. That simply restores today's state (no DMARC).

**Later tightening:** move to `p=quarantine; pct=25`, then 100, only after reading at least 7 days of reports.
Each change is a separate approval.

## 4. Resend readiness checklist (not changed)

| Item | State | Label |
| --- | --- | --- |
| `mail.teambalancepro.com` verified | The owner reports Resend "looks good"; the DNS side (DKIM, SPF, bounce MX) is present | DNS [VERIFIED]; dashboard status [OWNER-REPORTED] |
| Sending quota is enough for 100 RSVP / day plus account email (the staff pilot plans about 10 / day) | "Looks good" | [OWNER-REPORTED]; exact numbers [UNVERIFIED] |
| API rate limit is enough (documented default: 10 / second per team; RSVP paced at about 4 / second in code) | Pacing [VERIFIED in code] | Account value [OWNER-REPORTED] |
| **Open tracking disabled** | Must be confirmed explicitly | [UNVERIFIED] unless the owner confirms this specific setting |
| **Click tracking disabled** (it would rewrite the `/attend?c=…#token` links) | Must be confirmed explicitly | [UNVERIFIED] unless the owner confirms this specific setting |
| Existing account email unaffected | Unchanged code path (`src/lib/email/index.ts` unchanged since `f059181`); RSVP limits and suppression don't apply to it (tested) | [VERIFIED in code]; live health [OWNER-REPORTED] |
| Reply-to | Recommended `support@teambalancepro.com`. **Code currently sets no reply-to.** Adopting it needs a small reviewed code change (RSVP email only). Confirm the mailbox receives mail: `teambalancepro.com` MX is `mx1/mx2.improvmx.com` [VERIFIED]; whether an ImprovMX alias exists for `support@` is [UNVERIFIED] | Owner decision |
| Bounce / complaint webhook plan | Endpoint `https://teambalancepro.com/api/email/webhooks/resend`, events `email.bounced` and `email.complained` only, registered **after** the Production deploy; verification steps in `docs/M13B_PILOT_READINESS.md` §6 | Not configured [VERIFIED: `RESEND_WEBHOOK_SECRET` absent] |
| Webhook signing secret | Copy the `whsec_…` from Resend straight into Vercel `RESEND_WEBHOOK_SECRET` (**Production scope only**, "sensitive" type). Never paste it into chat, tickets, docs or the repo. Rotate by adding the new secret in Resend, updating Vercel, redeploying, then removing the old one (the verifier accepts any `v1` signature, so overlap is safe) | Procedure |

## 5. Owner approval checklist (decisions)

| # | Decision | Recommendation | Notes |
| --- | --- | --- | --- |
| O1 | Run the staff-only pilot **before** publishing the Privacy Policy / Terms changes? | Yes, **only** for the owner's and consenting staff addresses | Staff testers are still people whose data is processed: get their informed consent (what is stored, the 90-day retention, unsubscribe), keep it to the dedicated organization, and remove their data on request. This doesn't remove privacy obligations; it limits who is affected |
| O2 | Publish the Privacy Policy and Terms changes before **any** external recipient | Required | Drafts: `docs/legal/privacy-policy-m13b-draft.md`, `docs/legal/terms-m13b-draft.md`; decisions D1–D10 in `docs/M13B_OWNER_DECISIONS.md` |
| O3 | Reply-to | `support@teambalancepro.com` (needs the small code change noted in §4) or none for the staff pilot | |
| O4 | Retention cleanup schedule | Dry run, then daily, before external recipients | Not required for a 7-day staff pilot, but decide now |
| O5 | Bounce / complaint webhook before the first staff send? | Recommended. Optional for staff-only (no external addresses), required before external recipients | |
| O6 | Monitoring owner and backup | Name both | About 10 minutes / day for 7 days |
| O7 | DMARC reporting mailbox | Start with no `rua`; add one once a mailbox exists | |
| O8 | Resend tracking settings | Confirm open and click tracking are **off** | |
| O9 | Using Resend's test addresses (`bounced@resend.dev`, `complained@resend.dev`) | Optional; they aren't staff addresses, so approve explicitly | |
| O10 | Display name in `EMAIL_FROM` (`Team Balance Pro` vs brand `TeamBalance Pro`) | Optional; environment change | [VERIFIED] the current value is compatible |

## 6. Production-changing actions (each needs separate approval, in order)

1. Confirm Preview isolation in the Neon console (read-only; required before **any** push of the branch).
2. Add the DMARC record (`p=none`, no `rua`); verify propagation and a password-reset alignment check.
3. Confirm, or change, Resend open/click tracking (off).
4. Create the Neon snapshot branch `pre-m13b-<timestamp>Z`, and verify it read-only.
5. Push / merge to `main`, which runs the Production build: ten migrations, then the build. RSVP stays
   disabled. Then smoke-test sign-in, attendance, a Telegram poll and an account email.
6. (Recommended) Register the Resend webhook and set `RESEND_WEBHOOK_SECRET` (Production); redeploy; verify.
7. Create the dedicated internal pilot organization, group and test match, with exactly three staff Player
   contacts.
8. Set `RSVP_EMAIL_PILOT_ORGS` (the pilot organization id only) and `RSVP_EMAIL_DELIVERY=live-pilot` in
   Production; redeploy.
9. Send the first three invitations: a separate approval after the preview shows exactly three recipients.
10. Optional drills and changes (each separately): kill-switch drill, retention schedule, reply-to code change,
    `EMAIL_FROM` display name.

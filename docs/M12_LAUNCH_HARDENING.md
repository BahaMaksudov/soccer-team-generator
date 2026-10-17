# M12 — Launch hardening: findings, decisions needed, designs

Recorded 2026-10-16 on `feature/m12a-google-signin`. "Implemented" items are on
that branch; everything else needs an owner decision or an external account.

## 1. Implemented (low-risk foundations)

- `src/app/error.tsx` — app-wide error boundary: calm message, "Try again", a
  reference (Next.js error digest, also in the server log). No error text/stack.
- `src/app/global-error.tsx` — last-resort boundary for root-layout failures.
- Support contact in the homepage footer — **only** when `SUPPORT_EMAIL` is set
  (never invented). The same variable feeds the "coming soon" plan texts.
- Google Sign-In with explicit account linking (see `docs/M12A_GOOGLE_SIGNIN.md`).

## 2. Legal pages — content checklist (owner / counsel must supply)

Nothing below was written for publication; no legal claims were invented.

**Business facts needed for both pages:** legal entity name and type; registered
address / jurisdiction; contact email for legal and privacy requests; effective
date; governing law and venue; whether you sell to consumers, businesses or both;
age limit (e.g. 13+/16+ — needs a decision given youth sports).

**Privacy Policy must state (from what the code actually does):**
- Data collected: account (name, email, password hash, Google profile name/email
  when used), organizations / groups / roles, players (names, positions, ratings,
  stamina, attendance, optional email via claims), match data, results, MVP votes,
  recaps; Telegram identities and chat ids for connected groups and players;
  venue addresses and coordinates; IP-derived rate-limit digests (password reset).
- Processors / sub-processors: Vercel (hosting), Neon (database), Resend (email),
  Telegram (messaging), OpenAI (AI recaps — match facts sent when an organizer
  generates one), WeatherAPI and Geoapify (weather / venue search), Stripe (when
  billing launches), Google (sign-in), Upstash (if rate limiting is enabled).
- Purposes and legal bases; retention periods (decide: accounts, deleted
  organizations, delivery logs, password-reset request log = 1 day today).
- Player data entered by organizers about people without accounts — who is the
  controller, how players can request correction/deletion.
- User rights (access, correction, deletion, export) and how to exercise them.
- Cookies: session cookie (NextAuth), CSRF, the Google-link intent cookie; no
  advertising/analytics cookies today.
- International transfers (US hosting), security measures, children, changes.

**Terms of Service must cover:** service description; accounts and organizer
responsibilities (accuracy and consent for player data they enter); acceptable
use (Telegram groups, no spam); plans, trial (one 90-day trial per account; Free
afterwards; nothing charged), future paid billing, refunds and cancellation
(before live billing); availability / no warranty; limitation of liability;
termination and data deletion; third-party services; governing law; changes.

**Then:** add `/terms` and `/privacy` pages, link them from signup, footer and
the Google consent screen. Until then, keep the Google app in *Testing*.

## 3. Error monitoring — recommendation (not configured)

Recommended: **Sentry** (`@sentry/nextjs`) — first-class Next.js App Router
support (server, edge middleware, client, `global-error`), free tier sufficient
now. Plan: create the Sentry project (owner), add `SENTRY_DSN` (config) and
`SENTRY_AUTH_TOKEN` (secret, build-time source maps) to Vercel; scrub PII
(`sendDefaultPii: false`, strip emails / tokens / Telegram ids in `beforeSend`);
sample traces at ~0.1; alert on new issues + error-rate spikes to the owner's
email. Report from `error.tsx` / `global-error.tsx` and the cron route.
Alternative with zero new vendor: Vercel Log Drains → an existing log service.

## 4. Account and organization deletion — proposed design (not implemented)

Data dependencies (from the schema):
- **User delete** cascades: memberships, verification / reset tokens, OAuth
  links, link intents, trial notices, automation-email rows. `SetNull`: audit
  "created/updated/published by" columns, `Player.userId` (claimed player keeps
  existing as organizer data). **Blocker:** a User who is the only OWNER of an
  organization must first transfer ownership or delete the organization.
- **Organization delete** cascades: groups' settings, invitations, venues,
  billing rows, entitlement events, AI usage. **Restrict** blocks it while the
  group has players, matches, communities, team generations, Telegram chats /
  polls / user links, schedules or message deliveries — i.e. any real data.

Proposed design: (1) OWNER-only "Delete organization": re-enter password, type
the organization name; refuse while a paid Stripe subscription is active;
soft-delete first (`deletedAt`, hidden everywhere, Telegram chats disconnected,
automation stopped), hard-delete after a 30-day grace period by a reviewed job
that deletes in dependency order inside one transaction per group; (2) "Delete
my account": re-enter password (or Google re-auth), blocked while sole OWNER;
removes the User (cascades above), anonymizes audit columns (SetNull already);
(3) export before delete (JSON of the organization) as a follow-up. Needs:
retention period decision, legal text, and approval before any destructive code.

## 5. Rate-limiting coverage

Database-backed (always on, fails closed): password-reset requests.
Upstash (optional; **inactive and fail-open when not configured**): login
(credentials, per email), signup, verify-email, resend-verification, change
password, Google link/unlink, invitation and claim acceptance, Telegram connect
codes, match-link reads / writes, venue search, Game Day previews.

Finding: if Upstash is not configured in Production, **login has no brute-force
limit** (bcrypt cost only). Recommendation: confirm Upstash in Production, or
move login to the same database-backed limiter as password reset (small change,
no external account).

## 6. Production cron health

The only scheduler is `.github/workflows/match-automation.yml` (every 15 min;
GitHub runs it late or skips during load — observed gaps of hours). Failures
already fail the workflow (non-2xx or `ok:false`), and GitHub emails the
workflow's owner on failure. Missing: an alert when runs **stop**. Options
(owner's choice): a free heartbeat monitor (e.g. Healthchecks.io / Better Stack)
pinged by the workflow after a successful run; or Vercel Cron as a second clock
(needs `vercel.json`, approval). Both need an external setting — not done.

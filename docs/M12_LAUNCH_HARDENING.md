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
  venue addresses and coordinates; keyed digests of client addresses and emails for rate limits (password reset: 1 day; sign-in: 1 day, successful sign-ins 30 days).
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

## 5. Rate limiting

### Credentials sign-in (M12-A, implemented — `src/lib/loginLimit.ts`)

Every password check — sign-in (NextAuth Credentials, incl. the sign-in right
after signup), change password, connect / disconnect Google — goes through one
database-backed limiter. Upstash (`checkLoginRateLimit`) stays an optional first
layer.

| Limit | Threshold | Effect |
|---|---|---|
| Per client address | 10 **failed** checks / rolling 15 min | refused for that address ("Too many sign-in attempts…") |
| Per normalized email | 5 failed checks / rolling 15 min, counted since that email's last success | refused for that email from addresses that haven't signed in as it in the last 30 days |

- **Why these numbers:** 5 typos in 15 minutes is generous for a person, tiny for
  a password guesser (≤ 20 guesses/hour/email); counting only *failures* per
  address keeps offices, schools and carrier NAT working (successful sign-ins
  never consume the shared budget); 10 per address bounds spraying many emails.
- **Victim lock-out resistance:** an address that signed in successfully as an
  email within 30 days ("known pair") ignores that email's failure count, so an
  attacker hammering the email can't lock the owner out from their usual device /
  network. Google sign-in and password reset are never limited by it, and a
  completed password reset restarts the email's count.
- **Bounded:** refused checks are recorded as BLOCKED and not counted — a lockout
  ends 15 minutes after the failures that caused it.
- **Success resets** only that email's count (never an address's, never another
  user's).
- **Concurrency:** check + reservation in one transaction under advisory locks
  (address, then email); a reserved check is PENDING and counts as a failure until
  settled, so parallel bursts can't pass together (tested: 25 parallel → ≤ 5
  password checks).
- **Fail closed:** database unavailable → "Sign-in is temporarily unavailable";
  the password is never checked. Upstash missing / down → it allows (fail open)
  and the database limit still applies.
- **No enumeration:** unknown and existing emails are counted and answered
  identically; messages contain no thresholds.
- **Client address:** `src/lib/rateLimitKeys.ts`. Forwarding headers are trusted
  only on Vercel (`VERCEL=1`; Vercel overwrites `X-Forwarded-For`, sets
  `X-Real-IP`) or with `TRUST_PROXY_HEADERS=true` behind another trusted proxy.
  Otherwise all requests share one bucket (local development) — a spoofed header
  can't pick a fresh bucket. IPv4-mapped IPv6 → IPv4; IPv6 grouped by /64; ports
  and zone ids stripped.
- **Storage / privacy:** `LoginAttempt` holds only HMAC-SHA256 digests (key:
  `RATE_LIMIT_HASH_SECRET`, else `NEXTAUTH_SECRET`), outcome, source, timestamps —
  never emails, addresses, passwords, hashes or tokens.
- **Retention / cleanup:** SUCCESS rows 30 days (known pairs); all others 1 day;
  purged inside each check's transaction (indexed on `createdAt`). Volume = one
  row per password check.
- **Load:** one short transaction per check (two advisory locks, three indexed
  counts, one insert, one bounded delete) + one update after bcrypt. Pooled
  connection; no extra connection held during bcrypt.
- **Monitoring:** count `LoginAttempt` by outcome per hour (BLOCKED spikes =
  attack; LoginUnavailable in logs = database trouble). Sentry (section 3) would
  alert on `LoginUnavailable` errors.
- **Known limitations:** an attacker spreading guesses over many addresses is
  bounded by the per-email limit (≤ 20/hour), not stopped; a victim on a *new*
  network during an active attack waits ≤ 15 minutes or uses Google / reset;
  locally all requests share one address bucket.

| Variable | Kind | Notes |
|---|---|---|
| `RATE_LIMIT_HASH_SECRET` | **Secret** (optional) | dedicated HMAC key; falls back to `NEXTAUTH_SECRET` |
| `TRUST_PROXY_HEADERS` | Config (optional) | `true` only behind a trusted proxy other than Vercel; leave unset on Vercel |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Config / **Secret** (optional) | first layer only |

### Other limits

Database-backed (always on, fail closed): password-reset requests (M11.3).
Upstash (optional; inactive and fail-open when not configured): signup,
verify-email, resend-verification, invitation and claim acceptance, Telegram
connect codes, match-link reads / writes, venue search, Game Day previews.

**Preview acceptance (sign-in limit):** on the Preview URL, (1) 5 wrong passwords
for a test account → 6th attempt with the right password from another network
(phone on cellular) shows "Too many sign-in attempts…"; (2) the same account
still signs in from the browser that signed in before (known pair); (3) wait 15
minutes → signs in anywhere; (4) "Forgot password?" → reset → signs in at once;
(5) an unknown email behaves identically; (6) Google sign-in unaffected.

## 6. Production cron health

The only scheduler is `.github/workflows/match-automation.yml` (every 15 min;
GitHub runs it late or skips during load — observed gaps of hours). Failures
already fail the workflow (non-2xx or `ok:false`), and GitHub emails the
workflow's owner on failure. Missing: an alert when runs **stop**. Options
(owner's choice): a free heartbeat monitor (e.g. Healthchecks.io / Better Stack)
pinged by the workflow after a successful run; or Vercel Cron as a second clock
(needs `vercel.json`, approval). Both need an external setting — not done.

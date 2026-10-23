# M13B — Bulk RSVP email invitations

Status: **P1, P2 and P3 implemented locally** (`feature/m13b-p1-player-emails`). Nothing sends email.
Later phases are designed below and need approval one by one.

## Approved product decisions (final for M13B)

| Topic | Decision |
| --- | --- |
| Free and Trial allowance | 100 RSVP recipient emails per calendar month and 20 per calendar day, per organization (Trial keeps every other Pro entitlement) |
| Pro / complimentary / LEGACY allowance | 500 per month and 50 per day, per organization |
| Accounting window | UTC calendar day / month (the app's existing convention for monthly limits) — enforced from P2/P4, not in P1 |
| Recipient source | Organizer-entered contact email; otherwise the verified email of a linked player account |
| Answers | Yes / Maybe / No; opening a link never submits — the recipient confirms on the page |
| Unsubscribe | RSVP unsubscribe is per organization; hard bounce or spam complaint is a global suppression |
| Youth players | Organizers may enter a parent / guardian address; it is marked GUARDIAN, distinct from a player's own |
| Infrastructure | Existing sending domain (`mail.teambalancepro.com`); DMARC before real RSVP email; verified bounce / complaint webhook before the pilot |

## P1 — player contact email (implemented)

### Data

`Player` gains three nullable columns (migration `20261201120000_m13b_p1_player_contact_email`, additive):

- `contactEmail` — normalized address (trimmed, lowercased: the app's one canonical email form, same as accounts; Gmail dots and `+tags` kept);
- `contactEmailType` — `PLAYER` or `GUARDIAN` (new enum `PlayerContactType`);
- `contactEmailUpdatedAt`.

A CHECK constraint (`Player_contactEmail_type_together`) keeps the address and its type set or cleared
together. Existing players have all three NULL; nothing is backfilled. The linked account's email
stays on `User` and is never copied into, overwritten by, or shown through these fields.

Deferred tables (designed, not created in P1 — each lands with the code that uses it, so no unused schema
reaches Production):

- P3: `EmailSuppression` (global: unique `email`, reason `BOUNCED` / `COMPLAINED` / `MANUAL`) and
  `OrganizationEmailOptOut` (unique `organizationId + email`). Two tables, so the global uniqueness never
  depends on a nullable `organizationId`.
- P4: `RsvpSend`, `RsvpInvitation` (statuses QUEUED / SENDING / SENT / FAILED / UNCERTAIN / SKIPPED,
  unique per match, player and round) and `PersonalAttendanceLink.channel` (MANUAL / EMAIL). Tokens stay
  hash-only.

### Validation (`parseContactEmail`, `src/lib/emailAddress.ts`)

Blank or null clears. Control characters (CR/LF, NUL, DEL, U+0085, U+2028/2029) are rejected anywhere in the
raw input before trimming. At most 254 characters, local part at most 64, syntax via zod. Setting an address
requires the type; it is never guessed.

### API

`GET / PUT /api/admin/o/[org]/g/[group]/players/[id]/contact` — OWNER/ADMIN only (MEMBER, other group,
other organization or unknown id → the same 404; signed out → 401). JSON only, `no-store`.
`PUT { email: string | null, type?: "PLAYER" | "GUARDIAN" }`. Addresses are never logged.

### UI

Players page → a player's details → **Contact email**: address, "Whose email is this? Player /
Parent / Guardian", Save, Remove. It shows whether a linked account exists and is verified (the fallback
recipient). The account address itself is not shown, consistent with the existing booleans-only organizer
view of linked accounts.

### Recipient resolution (`resolveRecipient` / `loadRecipients`, `src/lib/playerContact.ts`)

1. Organizer contact (keeping PLAYER / GUARDIAN). A stored contact that no longer validates is
   `INVALID_CONTACT`: it never falls through to the account, so a guardian slot can't silently become the
   player's own inbox.
2. Otherwise the linked account's email, only if `User.emailVerifiedAt` is set. That is set solely by a
   completed email verification or a Google sign-in with a Google-verified email.
3. Otherwise `NO_EMAIL`.

Nothing sends or creates invitations.

### Privacy

The contact columns are read and written only by `src/lib/playerContact.ts`, its route and its UI component;
a unit test fails if any other source file references them. Every other Player query in the app uses an
explicit field list. Integration tests confirm the addresses are absent from: organizer and member rosters,
player create / update responses, the public players API, generated and published teams (the source of
Telegram posts and AI recap facts), share-link views, player match views and My Games. Deleting a player
deletes its contact data with the row.

**Before real sending (not P1):** update the live Privacy Policy. It currently lists only account and
organizer emails and says no marketing emails are sent. It must cover player and guardian contact emails,
RSVP invitations, unsubscribe and suppression, and correction or deletion of contact addresses.

## P2 — recipient preview (implemented; read-only)

`GET /api/admin/o/[org]/g/[group]/matches/[matchId]/rsvp-preview` (`src/lib/rsvpPreview.ts`):
OWNER/ADMIN only (MEMBER, foreign or unknown → the same 404; signed out → 401). `no-store, private`.
Returns explicit response objects with masked destinations only (`p•••@example.com`; the domain is kept so
organizers can sanity-check it).

The preview creates nothing (no email, no invitation or send records, no RSVP links or tokens, no usage) and
changes no attendance. A test compares the row counts of every table before and after.

**Refusals (409):**
- `TELEGRAM_MATCH` — poll, or a connected chat with Telegram in the plan (the existing `attendanceMode`);
- `MATCH_CANCELED`;
- `MATCH_COMPLETED`;
- `ATTENDANCE_CLOSED`;
- `DEADLINE_PASSED`.

**Classification** (the match's eligible roster — the same roster as personal attendance links —
in this order):

| Status | Meaning |
| --- | --- |
| `ORGANIZER_OVERRIDE` | An organizer set the player's status |
| `ALREADY_ANSWERED` | The player answered through any channel |
| `INVALID_CONTACT` | The stored organizer contact no longer validates (no fallback) |
| `NO_EMAIL` | No contact and no verified account email |
| `SUPPRESSED` | Globally suppressed (hard bounce / spam complaint) or opted out of this organization (P3; the reason is never shown) |
| `OVER_LIMIT` | Sendable, but beyond the allowance |
| `WILL_SEND` | Will be invited |

Group players who are **not** on the match's roster (inactive players; members of other communities for a
community match) are listed separately in `notOnRoster` with names only. They are never counted as
recipients and their destinations are not shown.

**Allowance:**
- In the plan catalog: Free and Trial 100 / month and 20 / day; Pro, complimentary and LEGACY 500 / 50.
- The preview shows **plan ceilings** (`kind: PLAN_CEILING`, `remaining: null`), not the remaining allowance; `OVER_LIMIT` is a provisional classification (`overLimitIsProvisional: true`).
- UTC calendar day / month, per organization.
- Previewing never counts.
- The sending ledger doesn't exist yet, so actual usage is reported as **unavailable** (not zero).
  `OVER_LIMIT` marks only recipients beyond the allowance itself (provisional).

**P4 quota enforcement (designed):** inside the send transaction, under a per-organization advisory lock,
against the `RsvpInvitation` ledger for the current UTC day and month.

| Delivery state | Counts toward usage? |
| --- | --- |
| QUEUED / SENDING | Yes (reserved) |
| SENT | Yes |
| UNCERTAIN | Yes (may have been delivered) |
| FAILED (definite rejection) | No |
| SKIPPED (never attempted) | No |

Interface: `reserveRsvpQuota(tx, organizationId, requested, now) → { granted, remaining }`. Recipients beyond
the remainder are marked SKIPPED / LIMIT, and the request returns 402 `PLAN_LIMIT` when nothing fits.

**UI:** match page → **Email invitations (preview)** (hidden for Telegram matches). It shows would-be-invited
and excluded counts, daily and monthly allowance, the provisional-usage note, masked destinations with their
source (Player / Parent-Guardian / linked account) and status, the not-on-roster list, and a **disabled**
"Send invitations — coming soon" button with no handler.

## P3 — suppression and unsubscribe (implemented; nothing sends)

**Data** (migration `20261205120000_m13b_p3_email_suppression`, additive):

| Table | Holds |
| --- | --- |
| `GlobalEmailSuppression` | Unique email; reason `HARD_BOUNCE` / `SPAM_COMPLAINT`; source |
| `OrganizationEmailOptOut` | Unique (organization, email); source `LINK` / `ONE_CLICK` |
| `EmailUnsubscribeToken` | Organization, email, purpose `RSVP_INVITATION`, unique SHA-256 hash, `expiresAt`, `usedAt` |

All addresses are in the canonical form. The global suppression never depends on a nullable organization
id. Opt-outs and tokens are removed if their organization is deleted. Account, password-reset and security
emails never consult these tables (tested).

**Token lifecycle** (`src/lib/emailSuppression.ts`):

- 32 random bytes; only the hash is stored.
- Bound to one organization, address and purpose.
- Issued per email by the sending engine (P4). It doesn't depend on invitation rows.
- Valid for 365 days, so old emails keep working.
- Using it is idempotent: the opt-out is one unique row. The first use is recorded and replays change
  nothing. An expired token is refused (410) and points the recipient to a newer email or
  support@teambalancepro.com.

**Two distinct flows:**

1. **Website** — the email's "Unsubscribe" link is `/unsubscribe#<token>`, with the token in the fragment
   so it never appears in a request URL.
   - The page is noindex and sends no Referer. It shows the organization and the masked address and
     changes **nothing** on load (read-only `POST /api/email/unsubscribe/preview`).
   - Only pressing **Unsubscribe** sends the same-origin JSON `POST /api/email/unsubscribe`.
2. **RFC 8058 one-click** — the email carries `List-Unsubscribe: <…/api/email/unsubscribe/one-click?t=…>`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; DKIM signs the message.
   - The mail provider POSTs exactly `List-Unsubscribe=One-Click` (form encoding). No page, no cookies, no
     same-origin check.
   - Any other body → 400. There is no GET handler (405): a link scanner can't unsubscribe anyone.
   - The token is in the URL here (RFC 8058 requires it), so it can appear in hosting request logs. It only
     unsubscribes one address from one organization's RSVP emails.

**Transport:** `OutgoingEmail.headers`, allow-listed to `List-Unsubscribe` and `List-Unsubscribe-Post`.
Values are single-line and checked before any network call; the memory transport enforces the same rules.

**Preview:** `SUPPRESSED` now applies. Precedence: `ORGANIZER_OVERRIDE` > `ALREADY_ANSWERED` >
`INVALID_CONTACT` > `NO_EMAIL` > `SUPPRESSED` > `OVER_LIMIT` (provisional) > `WILL_SEND`. Suppressed
recipients never use plan capacity. The reason is never shown, and other organizations' opt-outs are
never consulted.

**Organizers** see "Not receiving invitation emails" and can't bypass it. P4's send path re-checks
`suppressedFor` at send time, and there is no organizer-facing reversal.

**Resubscribe (future, recipient-initiated only):** a "receive invitations again" action that sends a
confirmation email to the address. Clicking its link removes that organization's opt-out. Global
suppressions are removed only manually after the address is shown to be deliverable again.

## P4 — sending engine (implemented; test outbox only)

`src/lib/rsvpSend.ts`. There is no HTTP route, page or server action for it, and the preview's Send button
stays disabled.

### Delivery lock (server-side)

`rsvpTransport()` is the only transport the engine uses. It returns the in-memory test outbox (or a fake
transport injected by a test) and only when `NODE_ENV=test`; anywhere else it throws
`RsvpDeliveryDisabledError`. `createRsvpSend` and `retryFailedInvitations` check it first and return
`DELIVERY_DISABLED`. `processRsvpQueue` throws before it recovers or claims anything. The module never
imports the Resend transport, `getEmailTransport`, or `fetch`, whatever `EMAIL_TRANSPORT` /
`RESEND_API_KEY` say. A unit test guards the source, and another checks that nothing under `src/app`
imports the engine.

### Data (migration `20261210120000_m13b_p4_rsvp_sending`, additive)

- `PersonalAttendanceLink.channel` (`MANUAL` default / `EMAIL`). Every existing link becomes `MANUAL`.
- `RsvpSend`: one organizer action for one match.
  - `kind` is `INITIAL` or `RESEND`, and `round` counts 1, 2, … per match (`@@unique([matchId, round])`).
  - `requestKey` is unique; it is the client's idempotency key (8–100 characters of `[A-Za-z0-9_-]`).
  - `createdByUserId` is set to null if the user is deleted.
- `RsvpInvitation`: one row per roster player per round (`@@unique([matchId, playerId, round])`).
  - Fields: status, `skipReason`, `email` (only for rows that will be sent), `recipientType`, `attempts`,
    `reservedAt` / `claimedAt` / `sentAt` / `failedAt`, `providerMessageId`, `lastError` (a sanitized
    category), `idempotencyKey`, `linkId`, `unsubscribeTokenId`.
  - `playerId`, `linkId` and `unsubscribeTokenId` are set to null when the row they point to is deleted.
- Organization, group and match foreign keys cascade on delete.

Rollback: drop the two tables, the three enums and the `channel` column. Existing data is unaffected.

### Flow

1. `createRsvpSend(context, matchId, { kind, requestKey })`, OWNER/ADMIN. One transaction:
   1. Lock the match row (`lockMatchForAnswer`: Match `FOR UPDATE`; chat / organization `FOR SHARE`).
   2. Take the organization's quota lock (`pg_advisory_xact_lock(hashtext('rsvp-quota:<org>'))`). The order
      is always match first, then organization, so there is no lock cycle.
   3. Re-check the `requestKey`, the match (Telegram, canceled, completed, closed or past deadline) and, for
      `INITIAL`, that no earlier send exists (`ALREADY_SENT`). A `RESEND` needs an earlier send.
   4. Re-classify the roster the same way the preview does: answered, override, no email, invalid contact,
      suppressed.
   5. Reserve up to the remaining day and month allowance. Rows that will be sent become `QUEUED` with
      `reservedAt`; every other roster player gets a `SKIPPED` row with a reason (`LIMIT` for rows over the
      allowance).
   6. If nothing can be sent, refuse with `PLAN_LIMIT` / `NOTHING_TO_SEND` / `NOTHING_TO_RESEND`, and
      create nothing.

   The same `requestKey` returns the existing send (`duplicate: true`), including under concurrency. The
   unique constraint is a backstop; the same key on another match or organization returns
   `REQUEST_KEY_CONFLICT`. Queuing sends nothing and creates no links or tokens.
2. `processRsvpQueue({ limit = 25, sendId?, now })`: the worker / scheduler continuation, bounded per call.
   1. Recover stale claims: rows in `SENDING` for more than 10 minutes become `UNCERTAIN` (`STALE_CLAIM`).
   2. Claim one `QUEUED` row at a time:
      `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`. It sets status to `SENDING`,
      increments `attempts` and stamps `claimedAt`, so concurrent workers never claim the same row.
   3. Re-check the claimed row. A deleted player, a refused match, a suppressed address, or an answer or
      override made meanwhile makes it `SKIPPED` (which releases its reservation).
   4. In one transaction, create a new `EMAIL`-channel personal link and an unsubscribe token (both
      hash-only), and record `linkId`, `unsubscribeTokenId` and `idempotencyKey = rsvp:<invitationId>:<attempt>`.
   5. Build and send the email with the RFC 8058 headers (`List-Unsubscribe`, `List-Unsubscribe-Post`) and
      the provider idempotency key.
   6. Record the outcome as below.
3. `retryFailedInvitations(context, sendId)`, OWNER/ADMIN, explicit. Under the same two locks it re-checks
   the match and eligibility, then re-queues `FAILED` rows with fewer than 3 attempts, up to the remaining
   allowance. A retry is a new attempt, so it gets a new idempotency key. `UNCERTAIN` rows are never retried.

### Outcomes and the quota ledger

| Status | Meaning | Counts against the allowance |
| --- | --- | --- |
| `QUEUED`, `SENDING` | reserved | yes |
| `SENT` | **accepted** by the provider (or, in P4/P5, the test outbox) — *not* proof of inbox delivery | yes |
| `UNCERTAIN` | timeout, network, 5xx, 409, stale claim — may have been delivered | yes (never released, never auto-retried) |
| `FAILED` | definite 4xx or configuration error before hand-off — not delivered | no (released) |
| `SKIPPED` | not sent (reason recorded) | no |

- **Durable ledger (P4 hardening, migration `20261212120000_m13b_p4_quota_ledger`).** Usage =
  *consumed* + *reserved*:
  - *Consumed* (`SENT`, `UNCERTAIN`) lives in `RsvpEmailUsage(organizationId, day, consumed)`: one counter
    per organization per UTC day. It holds no address, player or match reference, so deleting a match or
    player never gives allowance back. Deleting the organization removes it.
  - *Reserved* (`QUEUED`, `SENDING`) is counted live from `RsvpInvitation`. A queued row of a deleted match
    was never sent, so its release is correct.
  - A row moves from reserved to consumed in **one transaction**, under its row lock (`settle`). Stale
    recovery does the same in one SQL statement. Both parts of the usage are read in **one statement**
    (one snapshot), so a moving row is never counted twice or missed.
  - A hand-off whose invitation row disappeared mid-send (match deleted) is still counted. A row already
    recovered as `UNCERTAIN` is not counted again if the late send reports `SENT`.
  - Raw SQL passes timestamps as UTC ISO text cast to `timestamp`, never as `Date` parameters. A `Date`
    would be shifted by the session `TimeZone` (the local test database runs `America/New_York`; this was a
    real P4 bug in `claimedAt` and stale recovery, now fixed and tested).
  - Tradeoff: per-day counters instead of per-email rows. That is the smallest PII-free record, but
    per-recipient history disappears with the match. The `RsvpInvitation` rows remain the audit record
    while the match exists.
- Allowance is attributed to the UTC calendar day `[00:00Z, next 00:00Z)` and UTC calendar month **of the
  reservation**. An email reserved at 23:59Z and sent at 00:01Z counts on the earlier day, so it never
  moves between days.
- Free and Trial get 100 per month / 20 per day. Pro, complimentary and LEGACY get 500 per month / 50 per day.
- Reservations are made only under the organization's advisory lock, after the counts are read
  (READ COMMITTED). Concurrent sends for different matches therefore serialize and can't exceed either
  limit.
- A release (`FAILED` / `SKIPPED`) only lowers usage, so it needs no lock.
- The preview (P2 card) now shows the actual remaining / limit for today and this month, plus how many
  are used and queued.

### Personal link lifecycle

Raw tokens are stored nowhere, so an existing link can't be reused in an email. The two channels are
therefore kept apart:

- **MANUAL links** (copied by the organizer) are never touched by sending.
  - "Regenerate" (`issuePersonalLinks`) now replaces only MANUAL links, so an emailed link keeps working.
  - "Revoke" (`revokePersonalLink`) is an explicit organizer action and still revokes every channel.
- **EMAIL links:** each delivery attempt gets a new one.
  - When the email is **accepted** (`SENT`), the player's older EMAIL links for that match are revoked, so
    only the newest emailed link works.
  - When it is **FAILED**, its own unsent link is revoked and the earlier emailed link stays valid.
  - When it is **UNCERTAIN**, the link is kept, because the email may have arrived.
- An **older emailed link** used after a newer email was accepted is revoked. The page says the link was
  replaced by a newer email (state `replaced`, P5) and records nothing. The newest email's link, and any
  manual link, still work.
- Neither a FAILED nor an UNCERTAIN delivery can touch a MANUAL link: revocation after delivery is limited
  to `channel = EMAIL`, and to the attempt's own link on failure. Tests cover regenerate, a failed resend
  and an accepted resend.
- A player can therefore hold at most one active MANUAL link and one active EMAIL link. Both answer as the
  same player (`PERSONAL_LINK` source), and attendance semantics are unchanged.

### Logging and privacy

- The engine logs nothing.
- Stored errors are categories only (`HTTP_422`, `TIMEOUT`, `NETWORK`, `CONFIG`, `STALE_CLAIM`,
  `UNEXPECTED`).
- Addresses are stored only on invitations that will be sent, and only for the organization that owns them.
- **Known exposure:** the one-click URL carries the unsubscribe token in its query string, as RFC 8058
  requires. Request logs (for example Vercel's) may record it. The token can only opt that one address out
  of that one organization's RSVP emails, and it is stored hash-only on our side.

## P5 — organizer send, recipient RSVP and queue continuation (implemented; test outbox only)

### Delivery gate (`src/lib/rsvpDeliveryMode.ts`)

`rsvpDeliveryMode()` is the only switch, and it has no live mode:
- `test-outbox` when `NODE_ENV=test`;
- `test-outbox` in a **confirmed local test environment**, which needs all of:
  - `NODE_ENV=development`;
  - `RSVP_EMAIL_LOCAL_TEST_OUTBOX=1`;
  - no `VERCEL` / `VERCEL_ENV`;
  - `DATABASE_URL` pointing at `localhost` / `127.0.0.1` / `::1`, with a database name containing `test`;
- `disabled` everywhere else. Every production build (Production, Preview and a local `next start`) runs
  `NODE_ENV=production`.

When the mode is `disabled`:
- the Send API returns 403 `DELIVERY_DISABLED` before parsing, reading or writing anything;
- the cron continuation reports `{ disabled: true }` and claims nothing;
- the engine throws before claiming;
- the preview returns `sending.available: false`, so the button is shown disabled (the button only mirrors
  the server).

### Organizer workflow (match page → "Email invitations")

1. **Review:** who will be invited (masked destination, Player / Parent-Guardian / Linked account), who is
   excluded and why, and the actual remaining allowance today and this month (UTC).
2. **Confirm:** "Send an RSVP email to N recipients?" plus an unchecked box: "I'm authorized to contact these
   N recipients (players or their parents / guardians) about coordinating this match." Send stays disabled
   until the box is checked.
3. **Submit:** `POST …/matches/[matchId]/rsvp-send` with `{ action: "send", kind, requestKey, expectedCount,
   attested: true }`.
   - `requestKey` is generated once per confirmation (`crypto.randomUUID`), so a double click, network
     retry or concurrent submit returns the same send.
   - The server stores `attestedAt` and `confirmedCount` on `RsvpSend`.
4. **Progress:** the first batch is delivered inline (8 s budget); the cron continues the rest. The card
   polls every 3 s while anything is queued or processing.

Clear refusals (409):
- `ROSTER_CHANGED`, with the new count, when anything changed since the review (answers, contacts,
  unsubscribes, allowance);
- `DEADLINE_PASSED`, `ATTENDANCE_CLOSED`, `MATCH_CANCELED`, `TELEGRAM_MATCH`;
- `PLAN_LIMIT`, explaining the 00:00 UTC / 1st-of-month reset;
- `ALREADY_SENT` (use "Resend to unanswered" instead).

Rate limit (429): at most 10 new sends per organization per 10 minutes. This one is database-backed and
authoritative, and a repeated request key is still answered. An Upstash `rsvp-send` bucket per organizer is
an optional first layer.

### Send API (`rsvp-send/route.ts`)

- **Access:** OWNER / ADMIN only. MEMBER, another organization, another group's URL or an unknown match gets
  the same generic 404; signed out gets 401.
- **CSRF:** JSON content type plus a same-origin `Origin` header (the same convention as the answer endpoint).
- **Request shape:** a strict schema. The client can't name recipients, addresses, subjects or bodies; the
  server re-derives the roster under the locks.
- **Actions:**
  - `send` (`INITIAL` or `RESEND` to unanswered players);
  - `retry` (FAILED rows only; attempt limit and allowance apply; UNCERTAIN rows are never retried).
- **Errors:** anything other than a tenant error returns a generic 500, never an internal message.

### Delivery dashboard (`GET rsvp-send`, `src/lib/rsvpStatus.ts`)

Delivery status and RSVP status are reported separately:
- **Delivery:** Queued, Processing, Accepted (by the test outbox or the provider — never called
  "delivered"), Failed, Uncertain, Skipped (with its reason).
- **RSVP**, among players an email was meant for: Yes, Maybe, No, Unanswered. Organizer overrides are marked.
- **Uncertain** rows get an explicit warning: not retried automatically, still counted, check with those
  players before resending.
- Destinations are masked; no tokens or keys are returned.

### Invitation email

- **Content:** TeamBalance Pro branding, match name and date/time, venue, RSVP deadline, and Yes / Maybe /
  No buttons.
  - The buttons link to `/attend?c=yes|maybe|no#<token>`. The token stays in the fragment.
  - It also includes the plain answer link, why the recipient got the email, and an unsubscribe link plus the
    RFC 8058 headers.
- **Layout:** one responsive column (560px max) with inline styles, plus a plain-text alternative carrying
  the same links.
- **Wording:** guardians get a neutral greeting ("Hello,") followed by "You're receiving this as the
  parent / guardian contact for <player>".
- **Subject:** `RSVP: <match name> — <date/time>`, with no player name and no address.
- **No other players' data.**

### Recipient RSVP page (`/attend`)

- **Choice buttons only pre-select.** Opening a link (by a person, a mail scanner or a link preview) never
  changes attendance.
  - `?c=` only pre-selects the answer; saving needs an explicit **Confirm** tap ("Not now" dismisses it).
  - `?c=` is removed from the address bar after load.
  - Saving is a same-origin JSON POST, so scanners can't trigger it.
  - The existing answer buttons still save on tap (an explicit action, M12B behavior).
- **Answers:** Yes / Maybe / No (`PLAYING` / `MAYBE` / `NOT_PLAYING`, which the model already had; no
  downstream change). Repeated or racing submissions upsert one row. Existing locking and per-link rate
  limits are unchanged.
- **States:**
  - **closed:** the deadline passed or the organizer closed attendance;
  - **canceled;**
  - **telegram;**
  - **revoked:** the organizer revoked or regenerated the link;
  - **replaced** (new, via `PersonalAttendanceLink.replacedAt`): a newer emailed link was accepted for this
    player — "please use the link in the most recent email". The answer is refused with 410.
- **Organizer overrides** keep precedence. The answer is still recorded and the page says the organizer set
  the status.
- **No account is needed,** and the page shows only that player's own name and answer.

### Queue continuation

The existing scheduler is the GitHub Actions workflow that POSTs to `/api/cron/automation` every 15
minutes with the `CRON_SECRET` bearer. It now also runs `processRsvpQueue`:
- at most 200 claims within a 20 s budget (no new claim after the budget);
- claims use `FOR UPDATE SKIP LOCKED`, so overlapping runs never take the same row;
- stale rows are recovered as UNCERTAIN, and there is never an automatic retry;
- per-row errors are isolated and counted;
- the response contains counts only.

It is a no-op (`{ disabled: true }`) wherever the delivery gate is off, which is everywhere outside local
tests.

### Migration `20261215120000_m13b_p5_send_attestation` (additive)

- `RsvpSend.attestedAt`, `RsvpSend.confirmedCount`;
- `PersonalAttendanceLink.replacedAt`.

## P6 — delivery management, contact authorization, unsubscribe hardening, webhook (implemented; test outbox only)

Migration `20261220120000_m13b_p6_delivery_management` (additive):
- `Player.contactAuthorizedAt` and `Player.contactAuthorizedByUserId` (FK to User, set to null on user
  deletion), plus a CHECK that an authorization exists only together with a contact;
- `EmailUnsubscribeToken.oneClickOnly`;
- the `EmailWebhookEvent` table (provider, event id unique, type, outcome — no address).

### Contact authorization (`src/lib/playerContact.ts`)

- **When confirmation is needed:** a new or materially changed contact (a different normalized address, or
  PLAYER ↔ GUARDIAN) requires `authorized: true`. Wording depends on the type:
  - player: "this player gave me this address, or agreed to its use, for match coordination emails";
  - guardian: "this parent / guardian gave me this address …".
- **What is recorded:** who confirmed it and when, under the Player row lock in one statement.
- **What it doesn't change:** re-saving the same contact keeps its confirmation, and removing the contact
  clears it.
- **Wording:** the UI states that the confirmation "isn't verified and isn't a legal consent record".
- **What it doesn't collect:** no age, relationship or other details about minors or guardians.
- **Sending:** an unconfirmed contact is `CONTACT_UNCONFIRMED`. It is never emailed and never falls back to the
  linked account.
- **Send-time re-check:** the engine re-resolves the recipient at delivery. If the contact was changed,
  removed or unconfirmed after queuing, the row becomes `SKIPPED` (`CONTACT_CHANGED`), so the old address
  is never emailed.
- **Existing contacts:** contacts saved before P6 are unconfirmed until an organizer confirms them. P1 has not
  shipped to Production, so this affects only local data.

### Retry / resend review

P5's controls were kept and tightened rather than duplicated:
- **Retry:** FAILED rows only, fewer than 3 attempts, eligibility and allowance re-checked under the locks.
  Concurrent retries re-queue once. UNCERTAIN rows are never retried.
- **Resend:** unanswered, eligible players only. Excluded:
  - players who answered or have an organizer override;
  - unsubscribed or suppressed addresses;
  - unconfirmed contacts;
  - **new in P6:** players with an invitation still queued or sending (`IN_PROGRESS`), so a resend never
    duplicates an in-flight email.
- **Idempotent** per request key; manual links are untouched.
- **Confirmation dialog** (the shared accessible `Dialog`) before every send, resend and retry. The resend
  dialog warns when earlier deliveries are uncertain.

### Dashboard

Each recipient row shows:
- contact type (Player's email / Parent / Guardian / Linked account (verified)) and masked address;
- delivery label plus an explanation:
  - "Accepted by … — that doesn't confirm it reached the inbox";
  - "Not sent: … rejected it — you can retry";
  - "… didn't confirm — may or may not have arrived, not retried";
- the skip reason, when skipped;
- timestamps (queued, last attempt, accepted, failed) and the attempt count;
- **Suppressed** when the address has since unsubscribed or bounced;
- the RSVP answer, kept separate from delivery.

No raw tokens and no full addresses (including linked-account addresses) are ever returned.

### Unsubscribe security review

| Check | Finding |
| --- | --- |
| Token entropy / storage | 32 random bytes (base64url), only SHA-256 stored. ✔ |
| Expiration | 365 days, so old emails keep working; checked on every use. ✔ |
| Idempotency / replay | The opt-out is a unique row (insert-or-nothing). A replayed or used token returns ok and changes nothing. ✔ |
| GET never unsubscribes | No GET export on any unsubscribe route (405). The page only previews; it confirms via same-origin JSON POST. ✔ |
| RFC 8058 | POST with form body `List-Unsubscribe=One-Click` only; no cookies or Origin needed. Headers are covered by DKIM once live. ✔ |
| Referrer / analytics | The page token lives in the URL fragment (never sent to a server or in Referer) and is removed from the address bar after load. The app loads no analytics. Unsubscribe responses send `no-referrer`, `noindex` and `no-store`. ✔ |
| Query-string logging | **Residual risk.** The one-click URL must carry its token in the query string, and platform request logs (Vercel) may record it. **P6 mitigation:** that URL now uses a separate one-click-only token, which works only on the one-click endpoint. The preview and website confirmation treat it as invalid, so a logged URL reveals neither the organization nor the masked address; it can only unsubscribe that address from that organization. App code never logs URLs, tokens or addresses (source-guard test). Further options: shorter log retention or a log-drain filter, since platform logging isn't controllable from the app. |
| Cross-organization isolation | Tokens are bound to one organization and address; another organization's sending is unaffected (tested). ✔ |
| Global suppression | Hard bounces and complaints apply to every organization (webhook below). ✔ |

### Resend webhook (`POST /api/email/webhooks/resend`) — prepared, not registered

- **Verification:** Resend delivers webhooks through Svix (headers `svix-id`, `svix-timestamp`,
  `svix-signature`). `src/lib/webhookSignature.ts` follows Svix's published manual-verification spec:
  - HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`;
  - the key is base64-decoded after the `whsec_` prefix;
  - signatures are space-delimited `v1,` entries compared in constant time;
  - a ±5 minute replay window.

  It is unit-tested against Svix's published test vector. No new dependency was added: neither the `resend`
  SDK nor `svix` is installed.
- **Flow:**
  1. Size cap (256 KB).
  2. Signature check on the raw body.
  3. Parse.
  4. `processResendEvent`, idempotent per event id: the event row and the suppressions are written in one
     transaction, so replays and concurrent duplicates change nothing.
- **Events:**
  - `email.bounced` (Resend: "permanently rejected"; `bounce.type` "Permanent") → `HARD_BOUNCE`. A bounce
    with a different type is ignored.
  - `email.complained` → `SPAM_COMPLAINT`.
  - Other events are acknowledged and ignored.
  - Addresses are normalized. An existing suppression keeps its first reason. Nothing is logged or returned
    with an address.
- **Configuration:** fails closed (503) until `RESEND_WEBHOOK_SECRET` is configured. No endpoint is registered
  with Resend and no secret exists anywhere. Activation needs both, as an approved step.
- **Assumption to re-check at activation:** the payload fields (`type`, `data.to[]`, `data.bounce.type`) come
  from Resend's documentation. Verify them against a real test event from the Resend dashboard before
  relying on them.

### Privacy Policy

The proposed changes are in `docs/legal/privacy-policy-m13b-draft.md`. They are not published, and the
`/privacy` page is unchanged.

## P7 — retention, deletion policy, final hardening (implemented; nothing scheduled, test outbox only)

Migration `20261225120000_m13b_p7_retention` (additive):
- the enum value `GlobalSuppressionReason.RECIPIENT_REQUEST`;
- `RsvpInvitation.anonymizedAt`, plus an index on (`anonymizedAt`, `matchId`);
- `RsvpSend.retentionHoldUntil`.

The pilot plan is in `docs/M13B_PILOT_READINESS.md`.

### Retention (`src/lib/rsvpRetention.ts`, `runRsvpRetention`)

Foreign keys reviewed first:
- invitations cascade with their match / send / group / organization;
- `playerId`, `linkId` and `unsubscribeTokenId` are set to null when their row is deleted;
- the quota ledger (`RsvpEmailUsage`) has no match or player reference.

The cleanup:
- **Cutoff:** a match on UTC day D keeps its identifying details through D+90 and loses its direct identifiers from D+91
  00:00Z (`retentionCutoff`).
- **Identifier removal** (P8A wording: not anonymization) clears `email`, `providerMessageId` and `idempotencyKey`, and stamps `anonymizedAt` (Prisma: `identifiersRemovedAt`).
  It keeps status, round, timestamps, skip reason, error category, recipient type and the player reference,
  so the dashboard keeps its shape with no address.
- **Never touched:** attendance answers, the quota ledger, personal links (hash-only), opt-outs and
  suppressions.
- **Skipped and counted:** QUEUED / SENDING rows (active processing), and sends under an incident hold
  (`retentionHoldUntil` in the future).
- **Expired unsubscribe tokens** are deleted: they no longer work, and they hold an address.
- **Deleted matches** need nothing: their invitations are already gone, and the ledger keeps their usage.
- **Safety:** idempotent (`anonymizedAt IS NULL`); bounded (`batchSize` up to 5000, `maxBatches` up to 1000);
  one run at a time (transaction-scoped `pg_try_advisory_xact_lock`; a second concurrent run stops and
  reports `concurrentRunDetected`), with `FOR UPDATE SKIP LOCKED` as well.
- **Modes and output:** `dryRun` writes nothing; metrics are counts only.
- **Not scheduled anywhere;** a unit test guards that nothing imports it.

### Suppression and deletion policy

| Event | What happens to opt-outs / suppressions | Why |
| --- | --- | --- |
| Player deleted | Unchanged: opt-outs are per organization and address, not per player. A new player with the same address is still `SUPPRESSED`. | Deleting a player must not make an unsubscribed address mailable again. |
| Contact email changed | The old address's opt-out stays (blocks it everywhere in that organization); the new address is judged on its own. | No carry-over to a different person's address. |
| Organization deleted | Its own opt-outs cascade (nobody can send for it any more); global suppressions stay. | No orphaned per-organization data. |
| Recipient privacy request | **Superseded in P8A** (see below): erasure no longer converts or removes opt-outs; a global do-not-contact is recorded only on explicit request. | — |
| Resubscription | Not built. If added, it must be recipient-initiated (a confirmation email to the address), never organizer-initiated. | No organizer bypass (a source guard checks that only the support function can delete opt-outs / suppressions). |

**Why plain addresses, not hashes:** suppression must match the normalized address at send time. An unsalted
hash of an email address is easily reversed by guessing (addresses aren't secret), so it adds risk without
real protection. A keyed (HMAC) hash would protect against a database leak, but losing or rotating the key
silently breaks matching, so every stored record would need re-keying. Until that key management exists,
the minimal-retention approach is:
- keep only the address, reason, source and date;
- one row per address (global) instead of one per organization after an erasure;
- nothing else.

### Guardian authorization (re-review)

Confirmed by tests (P6 and P7):
- a new or materially changed contact needs the organizer's confirmation, with who and when recorded;
- unconfirmed contacts are never queued or emailed, and never fall back to the linked account;
- a contact changed after queuing (including between a failure and a retry) is never emailed at the old
  address (`CONTACT_CHANGED`);
- organization and group scoping is enforced;
- a source guard checks that the UI, emails and contact code never claim consent was verified.

Remaining legal review: whether an organizer's attestation is enough for minors' guardian contacts (versus a
guardian double opt-in), and the age-related laws that apply. See the open decisions in the legal drafts.

### Webhook review (against Resend / Svix documentation)

| Check | Result |
| --- | --- |
| Raw-body verification | ✔ Signature over the exact bytes received. P7 reads the body as a capped stream (`readCapped`), so a body over 256 KB is refused (413) without being buffered, with or without `Content-Length`. |
| Timestamp tolerance | ✔ ±5 minutes, the Svix library default. Non-numeric timestamps are refused. |
| Constant-time comparison | ✔ `timingSafeEqual` on equal-length digests. |
| Multiple signatures | ✔ A space-delimited `v1,` list; any match passes, so key rotation works. Non-`v1` entries are ignored. |
| Duplicate events | ✔ Event id unique per provider, inserted in the same transaction as the suppressions. |
| Concurrent events | ✔ The unique constraint decides; the loser reports `duplicate` (tested). |
| Event id validation | **P7:** `svix-id` must match `^[A-Za-z0-9_.:-]{1,128}$`, or the request gets 401 (previously truncated, which could collide). |
| Permanent vs transient bounce | ✔ `email.bounced` is documented as permanent (`bounce.type: "Permanent"`). Any other present type is ignored. |
| Complaints | ✔ `email.complained` → `SPAM_COMPLAINT` (an existing suppression keeps its first reason). |
| Malformed / oversized | ✔ Invalid JSON → 400; an invalid address in `to` is ignored; oversized → 413. |
| Missing / invalid secret | ✔ 503, nothing processed. |
| PII in logs | ✔ Only a fixed string on failure (source-guard test). |

The verification procedure for a real signed test event is in the pilot readiness doc, section 5.

### Unsubscribe and deliverability review

- **RFC 8058:** the two headers only (allowlisted), POST-only with the exact form body, idempotent.
- **Website flow:**
  - the fragment token is removed from the address bar;
  - preview is read-only;
  - confirmation needs a same-origin JSON POST.
- **Expiry and replay:** tokens expire after 365 days (P7 cleanup deletes them once expired); a replay changes
  nothing.
- **Hosting logs:** the one-click URL carries a one-click-only token that discloses nothing (P6). The
  remaining risk is Vercel request logs keeping that URL; an owner decision is needed on log retention or a
  log-drain filter.
- **Suppression precedence:** a suppressed or opted-out address is never `WILL_SEND`, whatever else is true.
  It is checked at queue time and again at send time, for every organization (global) or that organization
  (opt-out). Nothing lets an organizer override it.
- **Account / security emails** (verification, password reset, invitations) use a separate path that never
  consults suppression and never carries unsubscribe headers (source-guard test).
- **Deliverability checklist** (SPF, DKIM, DMARC, verified domain, sender identity, provider limits, webhook,
  rendering, tracking off): pilot readiness doc, section 4.

### Legal package

- Privacy Policy changes: `docs/legal/privacy-policy-m13b-draft.md` (updated for 90-day retention and
  privacy requests).
- Terms changes: `docs/legal/terms-m13b-draft.md`.
- Neither is published.

## P8A — release preparation and security audit (live transport built, default OFF)

Migration `20261228120000_m13b_p8a_support_opt_out` adds the enum value `EmailOptOutSource.SUPPORT_REQUEST`.
The Prisma field `RsvpInvitation.identifiersRemovedAt` maps to the existing column `anonymizedAt`, so the
rename needs no database change.

### Privacy erasure correction

P7's `eraseRecipientEmail` had two problems:
- it replaced an address's organization opt-outs with a global suppression, which widened a one-organization
  choice to every organization;
- `keepSuppression: false` could remove a do-not-contact record.

P8A's API is `eraseRecipientEmail(address, { scope, doNotContact })`:
- **scope** is `{ kind: "ALL" }` or `{ kind: "ORGANIZATION", organizationId }`. The removal (invitation
  identifiers, unsubscribe tokens, organizer contacts) is limited to that scope.
- **doNotContact** has no default; the caller must choose:
  - `"NONE"` records nothing new;
  - `"ORGANIZATION"` (requires an organization scope) records a `SUPPORT_REQUEST` opt-out for that
    organization;
  - `"GLOBAL"` records a `RECIPIENT_REQUEST` global suppression, only when the recipient asks for it.
- **Never weakened:** existing organization opt-outs stay organization-scoped and are never deleted or
  converted. Existing global suppressions (bounce, complaint, an earlier request) are never removed.
  Repeating a request doesn't lift anything.
- **No code path deletes opt-outs or suppressions** (source-guard test).

What is kept to make suppression work:
- `OrganizationEmailOptOut`: normalized address, organization, source, date;
- `GlobalEmailSuppression`: normalized address, reason, source, date.

No player, match or name is kept. Hashing the address isn't used: see P7, "Why plain addresses, not hashes".

### Retention audit — identifiers removed, not anonymized

`runRsvpRetention` removes the **direct identifiers** from an invitation:
- recipient address, provider message id, idempotency key;
- the link to the unsubscribe token (new in P8A).

It does not anonymize. The column comment, code, docs and legal drafts now say so.

| What remains on the row afterwards | Linkable to a person? |
| --- | --- |
| `playerId` → the named Player (until the player is deleted) | **Yes** |
| `matchId`, `organizationId`, `groupId`, `sendId` | Via the match / roster |
| `recipientType` (PLAYER / GUARDIAN / ACCOUNT) | Says whether the player had a guardian contact |
| status, round, attempts, skip reason, error category, timestamps | Only together with the above |
| `linkId` → personal answer link (hash-only token, last-used time) | Via the player |
| `RsvpSend.createdByUserId` → the organizer who sent it | Yes (organizer); an operational record |

Outside the invitation row:
- **Unsubscribe tokens** (address + organization) stay until they expire (365 days), so links in old emails
  keep working. Retention unlinks them from the invitation, and the cleanup deletes them once expired.
- **Quota counts** (`RsvpEmailUsage`) are per organization and day, with no person in them.

**Deleted players (P8A):** their invitation rows (`playerId` null) are now eligible at the **next run,
whatever the match date**, so the address doesn't stay for up to 90 days after the player is gone. Queued /
sending rows are still skipped until settled.

### Live transport (built, default off)

- **Mode** (`src/lib/rsvpDeliveryMode.ts`): `"live"` only when **all** of these hold, otherwise `disabled`:
  - `NODE_ENV=production` and `VERCEL_ENV=production` (never Preview, development or a local `next start`);
  - `RSVP_EMAIL_DELIVERY=live-pilot` (a new variable with one exact value);
  - a valid `RSVP_EMAIL_PILOT_ORGS` allowlist (1–10 cuid ids; one bad entry disables it);
  - `RESEND_API_KEY` set;
  - `EMAIL_FROM` as `Display Name <local@mail.teambalancepro.com>`.

  `NODE_ENV=test` is always `test-outbox`, never live.
- **Allowlist enforced on the server:** queuing, retry, the preview's `sending.available`, the send route
  (403 `DELIVERY_DISABLED`, identical for non-pilot organizations) and the worker (claims only allowlisted
  organizations' rows; others stay QUEUED).
- **Pilot limits** (constants, not environment):
  - 20 per organization per UTC day and 100 per month, the stricter of plan and pilot;
  - 100 per UTC day across all organizations, under a fixed-order advisory lock (match → organization →
    pilot). This protects the provider quota that account email shares.
- **Transport:** its own `createResendTransport` instance (fetch, no SDK). It reuses:
  - the queue, claims, idempotency keys (`Idempotency-Key: rsvp:<invitation>:<attempt>`), suppression,
    quota and contact re-checks;
  - the two allowlisted List-Unsubscribe headers;
  - error sanitizing (stored errors are categories such as `HTTP_422`, `TIMEOUT`, `NETWORK`).
- **Provider outcomes:**
  - 2xx → SENT (accepted);
  - 4xx except 409 (including 429) → FAILED, released, retry allowed;
  - 409, 5xx, network, timeout → UNCERTAIN, still counted, never retried automatically.
- **Account and security email** keep their own path (`getEmailTransport`). RSVP never touches it, and RSVP
  limits or suppression never block it (tested).
- **Logs** carry only fixed strings and provider ids. The fetch transport's existing log lines contain no
  address or token (tested by capturing console output).

### Security safeguards summary

- Delivery is decided on the server in one place; a disabled button is never the only gate.
- There are three gates to pass: Production-only mode, the exact flag, and the allowlist. Every
  misconfiguration fails closed.
- Preview can never be live (`VERCEL_ENV`).
- Old settings can't activate it.
- Limits are hard-coded, and there is a cross-organization cap.
- Webhook: Svix signature, a 5-minute window, a 256 KB streamed cap, strict event ids, idempotent.
- Unsubscribe tokens are hash-only, and one-click tokens are separate.
- No opt-out or suppression can be deleted by code; erasure never weakens a block.
- Tests replace global fetch with a fake Resend endpoint that counts any other network access.

## Open issues / risks

- Consent: organizers enter addresses (including guardians') without the recipient confirming. Unsubscribe
  (P3) and organizer attestation in the send flow (P2/P4) are the mitigations. Legal review of guardian /
  minor data was declined for the legal pages; the same risk applies here.
- Organizers can't yet see a linked account's address (only that one exists and is verified). That is
  intentional, but they may want to know where invitations will go. The preview (P2) can show the masked
  destination (for example `p•••@example.com`) if approved.
- DMARC is not configured for `mail.teambalancepro.com` / `teambalancepro.com`. It is required before P4 goes
  live.
- P8A: the live transport exists but is off. Turning it on is the approval-gated runbook in
  `docs/M13B_PILOT_READINESS.md` (DMARC is still missing).

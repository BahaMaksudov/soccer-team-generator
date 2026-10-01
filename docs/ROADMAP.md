# Team Balance Pro — Roadmap & Architecture Notes

Production: https://teambalancepro.com · Last updated: 2026-10-01

Roadmap sequencing may overlap for speed. This document does **not**
require every future feature before launch.

## Milestones

| Milestone | Scope | Status |
|---|---|---|
| M1 | Core Soccer Engine | COMPLETE |
| M2 | Telegram Integration | COMPLETE |
| M3 | Multi-Tenant Foundation | COMPLETE |
| M4 | Tenant Security & Isolation | COMPLETE |
| M5 | SaaS Owner Accounts & Onboarding | COMPLETE |
| M5.1 | Authentication Transition & Password Management | COMPLETE (legacy auth retired, `49f5a88`) |
| M6 | Player Engagement & Messaging Foundation | COMPLETE — M6-A/B/C live and production-verified (migrations #14–#16; prod `49ebde4`, 2026-10-01) |
| M6.1 | Telegram Identity Management (remove/disconnect a Player's Telegram link) | COMPLETE — live (prod `841853d`, 2026-10-01), no migration |
| M7 | AI Intelligence Layer | Planned |
| M8 | Multi-Sport Architecture | Planned |
| M9 | Match Experience & Player Engagement — Telegram-first no-signup match lifecycle (see below), scores, MVP, voting, attendance, statistics, history, leaderboards, achievements, shareable match experience | Planned |
| M10 | WhatsApp & Expanded Communications | Planned |
| M11 | Plans & Billing | Planned |
| M12 | Product UX / Analytics / Branding | Planned |
| M13 | Production Hardening | Planned |
| M14 | Commercial Launch | Planned |

## Product direction (M6+)

Players are **not** forced to create Team Balance Pro accounts to
participate, see their teams, or later see scores/results. Team Balance
Pro meets players where they already are — Telegram, later WhatsApp,
email, and lightweight web/share pages. Registered accounts are for
organizers (OWNER/ADMIN) and for players who *optionally* claim their
Player profile.

## Domain model — keep these separate

| Concept | Today | Rule |
|---|---|---|
| **User** | Authenticated account (email + bcrypt `passwordHash`, `emailVerifiedAt`). Organizer access via `OrganizationMembership` (OWNER/ADMIN/MEMBER). | Never required for a Player. |
| **Player** | Roster/sports identity, owned by exactly one Group (`groupId` NOT NULL, RESTRICT). Rating/stamina/position are organizer data. | Never requires a User. History (generations, polls, future stats) hangs off Player. |
| **Telegram identity** | `TelegramUserLink` (Telegram `userId` → `playerId`, `groupId`); `TelegramPollAnswer` keyed by Telegram `userId`. | External identity; maps to a Player, not a User. |
| **Future channel identities** | — | WhatsApp/email identities map to Players the same way (one link table per channel or a generic `ChannelIdentity`). |

**Player ≠ User ≠ Telegram identity.** Each relationship is optional and
independent: a Player may have a claimed User, a Telegram link, both, or
neither. A claim never implies a Telegram identity and vice versa.

Telegram identity is **Group-scoped** (M6-C): `TelegramUserLink` is
unique per `(groupId, userId)` and per `playerId` — the same Telegram user
can be one Player in each Group (soccer, volleyball, …), and inside one
Group an identity maps to at most one Player and a Player to at most one
identity. Legacy `Player.telegramUserId/telegramUsername/telegramFirst/
telegramLast` columns are unused (the webhook `/link <playerId>` that wrote
them is retired).

## M6 architecture decisions

### Optional Player ↔ User claim
- `Player.userId String?` → `User.id`, `onDelete: SetNull`,
  `@@unique([groupId, userId])` (a User claims at most one Player per
  Group; one User can hold Players in many Groups/sports).
- Claiming **links** the existing Player — never creates a new one — so
  all history stays attached.
- Claim requires proof: an organizer-issued claim link to the player's
  verified email (reusing the M5 hashed single-use token pattern), or a
  verified channel identity (e.g. a Telegram `/connect` code) already
  linked to that Player. Organizers can unlink.

### Group-level access
- Organizer authority stays **OrganizationMembership** (unchanged).
- Player-level access is derived from a **claimed Player in that
  Group** — no `GroupMembership` table yet. A separate player resolver
  (`resolvePlayerContext(user, org, group)`) requires
  `Player{userId, groupId}` and never grants organizer capabilities.
- Add `GroupMembership` only when a real need appears for Group-scoped
  organizers (e.g. a coach of one Group only). It would then carry
  organizer roles for a single Group, layered under OrganizationMembership.

### Low-friction viewing (visibility)
- `Group.visibility`: `PRIVATE | LINK | PUBLIC`.
  - PRIVATE — organizers and claimed players only.
  - LINK — revocable share link (random token, SHA-256 stored), no
    registration.
  - PUBLIC — today's `/g/[org]/[group]` behavior.
- Existing Groups migrate to PUBLIC (no behavior change for New England
  Eagles). New self-service Groups default to PRIVATE or LINK — today
  every new organization's Group is publicly viewable by slug.
- Player-facing pages render only an explicit allow-list: display name,
  team assignment, date (later: score, MVP). Never rating, stamina,
  Telegram ids or organizer settings.

### Root/home migration
- Today `/` redirects to the env-configured default public Group
  (`DEFAULT_PUBLIC_*`). Target: `/` = sport-neutral Team Balance Pro
  landing (Sign in / Get started); `/admin` = workspace dashboard;
  teams live under Group/match pages.
- Path: share the canonical Group URL with existing players first, then
  replace the redirect with the landing page (M12, or earlier if needed),
  then remove the `DEFAULT_PUBLIC_*` variables.

### Messaging architecture
- Core emits a small set of domain events (`POLL_CREATED`,
  `TEAMS_PUBLISHED`, later `MATCH_RESULT_POSTED`, `MVP_VOTING_OPENED`,
  `MVP_SELECTED`). A thin `src/lib/messaging/` layer renders a
  channel-neutral message and hands it to channel adapters
  (Telegram now; WhatsApp/email later). No event bus or queue.
- Delivery safety generalizes today's Telegram-only
  `TelegramPoll.teamsPostStatus` state machine into a per-channel
  delivery record (event key + channel + status + external message id),
  keeping the same claim → send → confirm semantics.

### Multi-sport
- M6 concepts (visibility, claims, messaging, share pages) stay
  sport-neutral; soccer-specific logic remains in team generation only.
  M8 owns the rules engine.

## M6 implementation batches

### M6-A — implemented (decisions as built)
- `Group.visibility` PRIVATE | LINK | PUBLIC; migration #14 backfills every
  existing Group to PUBLIC; new Groups default to **LINK**.
- Enforcement: `resolvePublicGroup()` is the single gate for every
  slug-addressed player-facing page/API — non-PUBLIC Groups resolve only
  for verified organizers of that Organization; otherwise "not found".
- Share links: `/share#<token>` — the token is in the URL fragment (never
  sent to the server, not in access logs or Referer) and POSTed to
  `/api/share/view`; SHA-256 stored only; shown once; rotation revokes
  the previous link; PRIVATE disables links without revoking them.
  OWNER/ADMIN manage visibility and links.
- Player-facing allow-list (`src/lib/playerFacing.ts`): names, position,
  team number, date. Public `/g` pages and share views use it.
- `Player.userId` nullable, `@@unique([groupId, userId])`, ON DELETE SET
  NULL — no claim UI yet.
- Messaging foundation (`src/lib/messaging/`): POLL_CREATED and
  TEAMS_PUBLISHED events → neutral content → Telegram renderer
  (byte-identical to the previous output). Not yet wired: a view link in
  the Telegram teams post (renderer + URL rules are ready; Close/Post
  output is unchanged), and the webhook's own poll command.

### M6-B — implemented (decisions as built)
- `MessageDelivery` (migration #15): one row per delivery of a core event
  (TEAMS_PUBLISHED) to a channel destination (TELEGRAM chat), bound to the
  Group (RESTRICT), with status SENDING / SENT / FAILED / UNCERTAIN,
  attempts, timestamps, provider message id and a safe failure code.
  Content stays in TeamGeneration; `contentHash` = SHA-256 of the message
  body (no link).
- Guarantees: per-poll advisory lock around decide + reserve (no double
  send from concurrent clicks); FAILED (definite rejection) is retryable;
  timeouts/network/unreadable replies and stale SENDING (> 2 min) are
  UNCERTAIN and never auto-retried — the organizer marks them sent or
  explicitly retries (which may duplicate: Telegram has no idempotency
  key). Telegram calls time out after 8 s.
- "Post Updated Teams": only when the published content differs from the
  last SENT content, and only with explicit intent.
- Legacy: migration copies POSTED → SENT and SENDING → UNCERTAIN; code
  dual-reads the old TelegramPoll columns and still writes them on
  success (rollback-safe). The old columns are dropped only after bake-in.
- Links: PUBLIC → canonical Group URL automatically; LINK → only an
  organizer-supplied ACTIVE share link of the same Group (hash-checked,
  never stored); PRIVATE → none.
- Close poll and deliver teams are separate steps behind the one button.

### M6-C — implemented (decisions as built)
- **Player claim** (`PlayerClaim`, migration #16): OWNER/ADMIN issues a link
  for an existing, unclaimed Player → `/claim#<token>` (fragment; SHA-256
  stored; shown once; 7-day expiry; single-use; a new link revokes the
  previous one). The page previews read-only; acceptance is an explicit
  POST by a signed-in, **email-verified** User and sets `Player.userId`
  only (no history, polls, answers, Telegram links or snapshots change).
  One Player per User per Group; Players in many Groups allowed. Already
  claimed → refused. Organizer **unlink** clears `Player.userId` only and is
  recorded on the claim row (`unlinkedAt/By`), as are creator, acceptor and
  revocation.
- **Access**: a claimed Player may view its own Group's player-facing pages
  even when LINK/PRIVATE (`viewerCanViewGroup`). It never grants organizer
  access — Admin pages/APIs still require OrganizationMembership.
- **/me (“My teams”)**: claimed Players across Groups with recent team
  assignments (allow-listed fields only) and Telegram connect.
- **Telegram /connect**: a claimed Player's account creates a 15-minute,
  single-use, 128-bit code (`TelegramConnectCode`, SHA-256 stored) and sends
  `/connect CODE` (or opens `t.me/<bot>?start=CODE` when
  `TELEGRAM_BOT_USERNAME` is set). The bot links the sender's Telegram id to
  that Player in its Group. Organizer linking still works unchanged; inside
  a Group re-linking moves an identity, and a Player already linked to a
  different identity gets a clear 409.

- **M6-A — Identity & visibility foundation:** `Player.userId` (nullable,
  unused by UI except organizer unlink), `Group.visibility` + share links,
  player-facing allow-list DTOs, visibility enforcement on `/g` pages,
  organizer visibility/share-link UI. One migration.
- **M6-B — Messaging foundation:** `src/lib/messaging` events + Telegram
  adapter, generalized delivery record (Telegram Close/Post moved onto
  it), share link in posts, organizer recovery for stuck `SENDING`, and
  explicit "post updated teams" after republish. One migration.
- **M6-C — Player claim & channel identity:** claim links, `/me` player
  view, Telegram `/connect` verification, and the `TelegramUserLink`
  per-Group uniqueness redesign. One migration.

### M6.1 — Telegram identity management (decisions as built)
- **Organizer "Remove Telegram link"** (Players table, Telegram column;
  OWNER/ADMIN only, confirmation required):
  `DELETE /api/admin/o/[org]/g/[group]/players/[id]/telegram`.
- **Player "Disconnect Telegram"** on `/me` (confirmation required):
  `DELETE /api/account/players/[playerId]/telegram` — only for a Player the
  signed-in, verified User currently claims; the Group is taken from that
  Player, never from the client.
- Both delete exactly one `TelegramUserLink`, addressed by validated
  `(playerId, groupId)` — **never by Telegram user id**, because the same
  Telegram identity may be linked to a Player in other Groups, which stay
  untouched. Player, `Player.userId`, claims, memberships, TeamGenerations,
  polls, poll answers and MessageDelivery are unchanged; unused /connect
  codes for that Player are dropped so an older code cannot re-link it.
- Idempotent (`removed: false` when nothing was linked); serialized with
  /connect via the same per-Player advisory lock; responses never contain
  the Telegram user id; no Telegram API call. Wrong tenant/role → generic 404.
- **Permissions are consistent:** organizer Telegram identity assignment
  (link a voter / move an identity, `telegram/link`) is now OWNER/ADMIN only,
  like removal — MEMBER, claimed Players without membership and other
  Organizations get the generic 404. Player self-service (`/connect`,
  Disconnect) depends only on owning the claimed Player, never on a role.
- Afterwards the voter shows as unlinked in that Group's imports and
  "unlinked voters" list until linked again (organizer voter linking or
  the player's /connect). No schema change.

## M9 requirement — Telegram-first, no-signup match lifecycle (confirmed 2026-10-01)

Telegram is a first-class player interface. A Player who never creates a
Team Balance Pro account must be able to follow the whole game lifecycle:

```text
Attendance poll
→ teams generated/published
→ Telegram team assignment
→ game played
→ organizer records final score
→ organizer explicitly publishes result
→ Telegram final-score announcement
→ MVP voting
→ MVP result/announcement
→ public match page
```

Future possibilities (not committed): player stats, leaderboards, streaks,
achievements, match history.

Rules:
1. A Player account is NOT required for the Telegram lifecycle.
2. Telegram MVP participation uses the existing Group-scoped Telegram
   identity (`TelegramUserLink`) where possible.
3. Saving/editing a score must NOT automatically send Telegram messages.
4. Telegram result publication requires an explicit organizer action.
5. MVP opening/closing/announcement are explicit organizer-controlled
   lifecycle actions unless a scheduled setting is deliberately introduced
   later.
6. Outbound result/MVP events reuse the durable M6-B delivery architecture
   (`MessageDelivery`: claim-before-send, idempotent, recoverable).
7. Public match pages use player-facing allow-lists and never expose rating,
   stamina, internal ids, Telegram ids, emails or admin-only data.
8. Registered/claimed Players may later get richer `/me` history, but signup
   remains optional.

## Future (captured, not scheduled in M6)

Scores, match results, MVP and MVP voting, goals/sport-specific stats,
attendance, leaderboards, win percentage, streaks, achievements, player
history, AI match recap, shareable match cards, Telegram/WhatsApp result
posts.

## Deferred backlog (still open)

- Secure TelegramChat registration.
- (M6.1 follow-up, non-blocking hardening) MEMBER can still call the
  read-only unlinked-voter endpoint (`telegram/users`), which returns Telegram
  usernames/ids, although MEMBER can no longer link voters. Evaluate
  restricting organizer identity-management data to OWNER/ADMIN.
- (M6.1 follow-up, non-blocking UX) MEMBER still sees the Telegram "Link"
  action (and Players-row identity controls) that end in a 404; hide/disable
  organizer identity mutation controls when the current role cannot use them.
- Drop the legacy TelegramPoll posting columns after M6-B bake-in.
- Telegram 4096-character message handling.
- Drop the unused legacy `Player.telegram*` columns.
- Upstash rate limiting not configured; password reset; multi-session
  revocation (M13).
- Stale pre-2D.7 ops scripts (outside the repo; do not use).
- Vercel Prisma advisory-lock (P1002) deploy risk.

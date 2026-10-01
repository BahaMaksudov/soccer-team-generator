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
| M5.1 | Authentication Transition & Password Management | COMPLETE after the legacy-auth cleanup is deployed |
| M6 | Player Engagement & Messaging Foundation | NEXT |
| M7 | AI Intelligence Layer | Planned |
| M8 | Multi-Sport Architecture | Planned |
| M9 | Match Experience & Player Engagement — scores, MVP, voting, attendance, statistics, history, leaderboards, achievements, shareable match experience | Planned |
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

Known constraints to resolve before identities span Groups:
`TelegramUserLink.userId` and `.playerId` are each globally `@unique`
(one Telegram identity → one Player in one Group). Legacy
`Player.telegramUserId/telegramUsername/telegramFirst/telegramLast`
columns predate `TelegramUserLink` and are unused by the canonical flow.

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

## Future (captured, not scheduled in M6)

Scores, match results, MVP and MVP voting, goals/sport-specific stats,
attendance, leaderboards, win percentage, streaks, achievements, player
history, AI match recap, shareable match cards, Telegram/WhatsApp result
posts.

## Deferred backlog (still open)

- Secure TelegramChat registration.
- TelegramUserLink multi-group identity redesign (M6-C).
- Stuck `teamsPostStatus=SENDING` recovery (M6-B).
- Repost revised teams after POSTED (M6-B).
- Telegram 4096-character message handling.
- Linking a Player already linked to another Telegram account fails with
  a generic error (unique `playerId`) instead of a clear message.
- `callTelegram` has no request timeout.
- Upstash rate limiting not configured; password reset; multi-session
  revocation (M13).
- Stale pre-2D.7 ops scripts (outside the repo; do not use).
- Vercel Prisma advisory-lock (P1002) deploy risk.

# Team Balance Pro — Roadmap & Architecture Notes

Production: https://teambalancepro.com · Last updated: 2026-10-03

Sequence decided 2026-10-01: Multi-Sport moved before AI (M7 ↔ M8 swapped)
so AI consumes a sport-neutral engine instead of soccer-only assumptions.

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
| M7 | Multi-Sport Foundation — sport registry, sport-neutral balancing engine, Add Group (migration #17) | COMPLETE — migration #17 deployed (`ff29508`), production data verified unchanged, basketball production smoke passed, first M7 generation metadata verified (2026-10-01) |
| M8-A | Deterministic Balance Intelligence — quality levels, roster notes, achievable role coverage, best single swap, Apply Swap (no LLM, no migration) | COMPLETE — deployed (`3f5f368`) and manually production-smoke-tested |
| M8-B | Optional LLM explanation | DEFERRED — deterministic explanations cover the M8 value; generative AI is better spent on recaps/communication (M9/M10.5) |
| M9-A | Match, Attendance & Telegram Foundation — Matches, channel-neutral attendance, Generate/Publish for a Match, Telegram attendance adapter, self-service Telegram connection, OWNER/ADMIN send boundary, public player-id privacy, /me next match (migration #18) | COMPLETE — production manual validation passed (prod `64233ba`, 2026-10-02) |
| M9-B | Telegram Channel Scope & Match Identity — per-Match TeamGeneration identity, chat ↔ Player scope, channel-scoped attendance UX, disconnect/reconnect hardening | COMPLETE — deployed with migration #19 (prod `805339b`, 2026-10-03) |
| M9-C | Match Player Experience — match-scoped player page, visibility-aware access, "View teams online" → exact Match, player-safe Match DTO, optional sign-in CTA | COMPLETE — deployed without migration (prod `5a66485`, 2026-10-03) |
| M9-D | Result, MVP & AI Recap — result save/publish/post, Telegram MVP vote + deterministic winner, AI-assisted recap with deterministic fallback | COMPLETE — migration #20 (prod `8dec585`, 2026-10-03). **M9 is functionally complete for the MVP scope.** |
| M10 | WhatsApp & Expanded Communications — GroupChannel, primary channel, WhatsApp identity, Meta Cloud API, multi-channel delivery | Planned (next) |
| M10.5 | Organizer Agent & Match Automation — scheduled attendance → import → generate → analysis → organizer approval → publish/post; optional game-day updates (weather) | Planned |
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
  sport-neutral. Since M7, sport-specific logic lives only in the sport
  definitions (`src/lib/sports`), never in the engine.

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

## M7 — Multi-Sport Foundation (decisions as built)

- **Sport registry in code** (`src/lib/sports/`): Soccer (`soccer`),
  Basketball (`basketball`), Volleyball (`volleyball`), American Football
  (`flag_football`), Other (`other`). Each definition: roles (key, label,
  weight), default role, role rules, stamina coefficient, terminology
  (Position/Role), messaging vocabulary (emoji, game noun, result label) and
  — for M9 only — `resultFormat` (POINTS / SETS). No sport tables.
  American Football keeps the stable internal key `flag_football` (display
  label "American Football" since the M7 follow-up; no data change); its
  roles can be expanded later without changing the key.
- **Group.sportKey is immutable** after creation (no update path; enforced
  by tests). Different sport → create another Group.
- **Skill** = the existing `Rating` enum (FAIR/GOOD/VERY_GOOD/EXCELLENT),
  shown as "Skill", meaning skill in this Group's sport. Player is per Group,
  so one person can be EXCELLENT at soccer and GOOD at basketball through
  separate Players optionally linked to one User. Admin-only, never public.
- **Stamina** stays 1–5 (default 3), optional under "More"; the sport supplies
  the default coefficient (volleyball 0.5, others 1).
- **Roles**: `Player.position` is a sport-scoped role key (TEXT since
  migration #17; existing soccer values preserved byte-for-byte), validated
  server-side against the Group's sport. Role rules: SEED (placed first —
  soccer goalkeeper), SPREAD (soft — basketball Big, volleyball Setter, American
  football QB), IGNORE. Shortages are `ROLE_SHORTAGE` warnings, never
  failures; unknown legacy roles → `UNKNOWN_ROLE` (balanced as the default
  role). Hard constraints only: ≥2 teams, ≥teamCount players, sizes ±1, no
  dropped/duplicated players. `format` (6|7|8) is deprecated and ignored.
- **Engine** (`src/lib/balanceEngine.ts`, `balance-v2`): pure, deterministic,
  returns teams + aggregate metrics + structured warnings. Soccer output is
  byte-identical to the pre-M7 generator (seeded parity test, 5000 rosters,
  frozen oracle in `src/lib/__tests__/fixtures/`).
- **Generation metadata**: publishes record `TeamGeneration.sportKey`,
  `engineVersion`, `metricsJson` (aggregates only — no ids/names/identity).
  NULL = legacy pre-M7 generation (never backfilled). `teamsJson` shape is
  unchanged; snapshots stay allow-list-built; metrics never read raw
  `teamsJson`.
- **Add Group** (`/admin/o/[org]/groups/new`, OWNER/ADMIN): name, sport,
  timezone; onboarding offers all five sports.
- **Settings**: role weights per sport (bounded, only the sport's role keys).
  The rule-strength editor (Strong/Prefer/Off) is deferred — registry
  defaults apply.
- **Messaging**: the existing Telegram teams post is unchanged (its
  contentHash drives delivery state); new content takes vocabulary from
  `messagingVocabulary(sportKey)`.
- **Branding**: product wording is "Team Balance Pro" (no "Soccer Team
  Generator").

### M7 completion (2026-10-01)

- **Migration #17** deployed once via the normal Vercel deploy; read-only
  before/after fingerprints of every existing table were identical
  (Player positions byte-for-byte; 32 legacy generations keep NULL
  sportKey/engineVersion/metricsJson).
- **Manual production smoke — Basketball** ("Pickup basketball",
  `basketball`), accepted by the owner as the representative multi-sport
  smoke: basketball label, Role and Skill fields, stamina default 3, only
  basketball roles, no goalkeeper behavior; Generate (2 teams, 4 players incl.
  one Big) showed "Bigs: 1 across 2 teams"; Preview, Publish and the public
  Group page worked; no Telegram message. **Big SPREAD with 2+ Bigs was NOT
  manually verified** (one Big only) — it is covered by automated/integration
  tests.
- **First M7 generation metadata (read-only verified):** the basketball
  publish stored `sportKey=basketball`, `engineVersion=balance-v2` and
  aggregate `metricsJson` (team sizes, impact/skill/stamina spreads, role
  counts, Big coverage) with no identity data (no ids, names, emails,
  Telegram/phone/WhatsApp fields, tokens or sessions).
- **Volleyball, American Football (`flag_football`), Other:** accepted on
  automated unit + real-PostgreSQL integration coverage (no manual
  production smoke by owner decision).
- **American Football label:** the sport added in M7 under the stable internal
  key `flag_football` is displayed as "American Football" (recreational/
  pickup roles: Quarterback, Receiver, Rusher / Line, Defender, Athlete /
  Any). The key is kept for compatibility — no migration, no data rename, no
  `american_football` key.

## M8 — Balance Intelligence & AI

The deterministic engine stays authoritative; no LLM ever generates teams or
judges fairness. **M8-A deliberately uses deterministic intelligence, not
generative AI, for fairness decisions.**

### M8-A — Deterministic Balance Intelligence (decisions as built)

- `src/lib/balanceAnalysis.ts` analyzes teams AFTER `balance-v2` (the
  generator is unchanged; soccer parity still 5,000/5,000). Pure,
  deterministic, registry-driven (no sport or role is named in the code).
- **Quality levels** (`balance-analysis-v1` constants, not Group settings),
  from the team impact spread: EVEN < 4 · CLOSE 4–9 · UNEVEN ≥ 10. No
  0–100 score or "% balanced".
- **Roster quality vs assignment quality** are separate: role shortages
  caused by the roster are roster notes (INFO; NOTICE when the sport's rule
  warns — goalkeeper, setter, quarterback; Bigs are INFO), uneven team sizes
  and unknown roles are INFO. Role coverage is judged against what is
  achievable: min(teamCount, ⌊available ÷ perTeam⌋).
- **Best single swap**: exhaustive cross-team pairs (12/2 → 36 … 30/5 → 360
  candidates), never lowering any role rule's covered-team count; ranked by
  impact spread → average-skill spread → stamina spread → same role → stable
  order. Suggested only if it improves the spread by ≥ 5 AND improves the
  level (UNEVEN→CLOSE/EVEN, CLOSE→EVEN).
- **Apply Swap** (`POST …/generate/swap`): preview only — never publishes,
  posts or changes Players/settings. The server re-reads the Group's Players,
  sport and settings and applies the swap only if it is exactly the current
  suggestion (else 409 with fresh analysis); same access as Generate.
- **Deterministic explanation** sentences from the analysis with sport labels
  ("Teams are closely matched.", "1 Setter available for 2 teams.",
  "A single swap can make the teams more even."). Raw strength numbers only
  under Details, never presented as a skill-level conversion. Admin only —
  nothing on public pages.
- **Persistence**: Generate returns `analysis`; Publish stores `metricsJson`
  as `metrics-v2` (`metricsVersion`) with an `analysis` block
  (`analysisVersion: balance-analysis-v1`: quality, spreads, team sizes,
  roster notes, role coverage, improvable). Swap suggestions, player ids and
  summary text are never stored. Pre-M7 (NULL) and M7 (unversioned =
  metrics-v1) rows are read tolerantly and never backfilled. No migration.

### M8-B — Optional LLM explanation (DEFERRED)

Deterministic explanations deliver most of the value. Generative AI belongs
where wording matters more than facts — match recaps, friendly
communication, weather wording, Organizer Agent interaction — always fed by
verified structured facts. If revisited: on-demand only, pseudonymous
team-level payload, kill switch, timeout, cost cap, never in the Generate/
Publish/Telegram path.

## M9-A — Match, Attendance & Telegram Foundation (decisions as built)

- **Match** (`Match`): id-identified (several Matches per Group per day are
  allowed), date-only `date` + optional local `startTime` ("HH:MM", Group
  timezone) + optional `locationName` (label only — no address/coordinates;
  M10.5 adds geodata). Stored status only SCHEDULED / COMPLETED / CANCELED;
  attendance-open/teams-ready/published are derived. No backfill: legacy
  generations/polls keep `matchId = NULL` and the by-date flow still works.
- **Attendance** (`AttendanceResponse`, unique Match+Player): PLAYING /
  NOT_PLAYING / MAYBE. Keeps the participant's own latest response (WEB from
  `/me`, or a linked TELEGRAM vote — latest wins) AND an organizer override
  (authoritative until "Clear override"); effective = override ?? participant
  (`src/lib/attendance.ts`, the only precedence code). MAYBE is never
  confirmed: Generate-from-Match preselects only PLAYING. "Close attendance"
  stores a timestamp; later answers are recorded and flagged late. No Telegram
  ids in core attendance; no automatic cutoff (M10.5).
- **Teams for a Match**: the existing Generate → M8 Balance → Apply Swap →
  Publish, with Publish carrying `matchId` (same Group and date, validated).
  `TeamGeneration.matchId` is nullable/unique. **Known transitional
  limitation:** TeamGeneration is still unique per (Group, date), so only one
  Match per day can have saved teams; a second same-day Match's publish is
  refused (409) — never re-linked or overwritten.
- **Telegram attendance adapter**: Match polls are `TelegramPoll` rows with
  `matchId` and `kind = ATTENDANCE` (MVP reserved for M9-B) and options
  ✅ Playing / ❌ Not playing / 🤔 Maybe (indexes 0/1 unchanged for legacy
  polls). The webhook syncs linked voters live; unlinked voters stay
  provider-only (a count is shown). "Sync Telegram attendance" replays stored
  answers through the same mapping without overwriting newer answers.
- **Post poll to Telegram** (OWNER/ADMIN) is idempotent through
  `MessageDelivery` (`ATTENDANCE_POLL_POSTED`, `matchId`): reserve → send →
  finalize under a per-Match lock; same content already SENT is a no-op,
  changed match details need "post updated", UNCERTAIN is never retried
  blindly. Team posts from a Match reuse Close & Post and record `matchId`.
- **Self-service Telegram connection** (Communication Channels, OWNER/ADMIN):
  one-time `g_` code (15 min, single use, SHA-256 only) →
  `t.me/<bot>?startgroup=<code>` (Telegram delivers `/start@<bot> <code>`) or
  `/connectgroup@<bot> <code>` (addressed form reaches privacy-mode bots) → the
  sender must be a non-anonymous administrator of that Telegram group
  (`getChatAdministrators`) → the chat binds to exactly that Group. A chat
  bound to another Group is refused without revealing it. Disconnect keeps
  history; reconnect needs a new code; supergroup migration keeps the binding.
  UI shows titles, never raw chat ids. Ops-script binding is legacy only.
- **Retired:** Telegram `/poll` (anyone in a chat could post polls; now a
  guidance reply, creates nothing) and `/chatid` (no ids revealed).
- **Permissions:** MEMBER keeps internal operations (Matches, attendance,
  Generate, Apply Swap, Publish). OWNER/ADMIN only: anything that sends
  externally, Telegram identity data, and channel configuration — every
  Telegram endpoint (chats, polls, voters, import, create poll, close & post,
  delivery status/mark-sent) answers MEMBER with the generic 404 server-side,
  and the UI hides those controls.
- **Publish ≠ Send** is structural: no-send services (Generate, Apply Swap,
  Publish, Match save, attendance) never import send code (static tests).
- **Privacy:** the public players API no longer returns internal Player ids.
- **/me**: a claimed player sees the next Match, sets their own attendance,
  and sees their team once published for it.
- **Manual-smoke fix:** the Match Teams selection is derived on every refresh
  (effective PLAYING ± the organizer's explicit checkbox adjustments,
  `src/lib/matchSelection.ts`), so overrides, cleared overrides, Telegram/web
  answers and sync all update it; an adjustment is dropped only when that
  player's effective attendance changes.
- **Manual-smoke fix (published vs preview):** the Teams panel keeps the
  PUBLISHED teams (from the TeamGeneration snapshot, returned by the Match
  view so they survive reload) separate from the unsaved WORKING PREVIEW.
  Generate/Regenerate, Apply Swap, Clear Preview and selection/attendance
  changes never write TeamGeneration or the public page — only Publish does
  (overwrite of the same row, no duplicates), and Publish never sends. The
  button reads "Regenerate" once teams exist; Publish is offered only for a
  preview whose assignment differs structurally (`src/lib/teamAssignment.ts`:
  order-insensitive within a team, a moved player counts). "Post Updated
  Teams to Telegram" appears only when durable MessageDelivery hashes say the
  published teams changed since the last post. M9-A remains open pending the
  manual smoke.
- **UX rule:** Published = canonical player-visible teams; Preview = the
  organizer's working copy. One full team table is shown at a time — while a
  different preview is open, the published teams are summarised as "A
  published version already exists". Communication actions always target the
  canonical published version, never an unpublished preview, and Telegram
  team posting is hidden while such a preview is open.

### M9-A completion (2026-10-02)

Production manual validation passed: Match creation; attendance poll posted to
Telegram; Telegram "Playing" votes sync live; organizer overrides and cleared
overrides; attendance-derived selection stays synchronized with manual
adjustments; Generate/Regenerate, Balance analysis and Apply Swap; published
teams separate from the unpublished preview (Regenerate/Clear/Swap never touch
them; only Publish replaces them; the public page changes only on Publish);
Telegram team posting uses the canonical published TeamGeneration, is hidden
while a different preview is open, and the explicit Post delivered the
expected teams. "View teams online" works but opens the Group-wide page
(→ M9-C).

## M9-B / M9-C / M9-D — requirements and design (recorded 2026-10-02)

Found in real production use (Indoor Soccer: 30 roster players, 2 connected
Telegram chats; one chat contains only a subset of the roster):

- **Telegram chat roster ≠ Group roster.** A chat connected to a Group must
  not be assumed to contain every Player. A Group may have several chats,
  later WhatsApp, and Players on no channel at all.
- **Channel-scoped player scope is required** (M9-B): a Telegram-specific,
  organizer-curated `TelegramChat ↔ Player` association (working name
  `TelegramChatPlayer`, unique per chat+Player, Group-checked, cascades with
  the chat or Player), seeded by explicit "add players who voted in this
  chat" suggestions from linked voters. It is a *default view*, never an
  eligibility rule: the Match roster shows the chat's players by default,
  the organizer can add any Group Player, and anyone with attendance for the
  Match is always shown. Generalize to a channel-neutral association when
  GroupChannel arrives (M10); the table maps 1:1 onto it.
- **Telegram membership stays optional** for being a Player or playing a
  Match; attendance stays Group-scoped (a linked vote counts from any chat of
  the Group).
- **The Bot API cannot enumerate a group's members** (only administrators,
  single-member lookup, member count, and `chat_member` events when the bot
  is an admin and opts in). Scope never depends on full enumeration;
  historical poll votes are evidence for suggestions, not membership truth.
- **Disconnect/reconnect** (M9-B): disconnect becomes a soft disconnect so a
  reconnect of the same chat to the same Group restores its scope; binding a
  previously disconnected chat to a *different* Group starts empty (old
  associations removed in the same transaction). A chat connected to Group A
  never applies to Group B.
- **Match identity before match pages** (M9-B, first step): TeamGeneration
  moves from date identity to Match identity — `(groupId, date)` uniqueness
  only for legacy rows without a Match (partial unique index), `matchId`
  unique for Match rows. Today a second same-day Match's publish is refused
  (409), so nothing is corrupted; production has no same-day Matches.
- **"View teams online" becomes match-scoped** (M9-C):
  `/g/[org]/[group]/matches/[matchId]` for PUBLIC Groups and for organizers /
  claimed Players of non-PUBLIC Groups; LINK Groups use the share capability
  plus the Match (token stays in the URL fragment). PRIVATE posts carry no
  link (unchanged). The page shows only an allow-listed Match DTO (date, time,
  venue label, sport, team numbers, player display names and public
  role labels; later result/MVP/recap) — never rating, stamina, metrics,
  Telegram/User/Player ids, unpublished previews or organizer attendance
  metadata.
- **No signup to view ordinary allowed match teams.** Richer identity later:
  Telegram identity → `TelegramUserLink` → Player → optional User, through
  the existing claim + `/connect` flows (or a verified Telegram login);
  never a client-supplied Telegram id, never a duplicate Player.
- **Publish ≠ Send, Group/channel isolation and OWNER/ADMIN sends** stay
  invariants; legacy `/poll` (retired) and MEMBER Telegram privacy/actions
  (server 404 + hidden UI) were resolved in M9-A and must stay covered by
  tests.
- **Future WhatsApp reuses the canonical Match lifecycle**; channels point
  into a Match, they never own it.

## M9-B — Channel Scope & Match Identity (decisions as built, 2026-10-03)

- **Match identity (migration #19):** a Match's TeamGeneration is addressed
  by `matchId` (unique); `(groupId, date)` uniqueness applies only to legacy
  rows — raw-SQL partial unique index `TeamGeneration_groupId_date_legacy_key`
  `WHERE "matchId" IS NULL` (Prisma cannot express it; keep it). Same-day
  Matches publish independently; a legacy by-date publish never touches a
  Match's teams; republishing a Match overwrites only its own row (the date
  follows the Match). Close & Post refuses a Match poll + another Match's
  teams. Delete-by-date (legacy Group page) still removes every published
  set of that date in the Group.
- **`TelegramChatPlayer`** — organizer-curated DEFAULT player scope of a
  chat, keyed by Player (never a Telegram id), source ORGANIZER /
  SUGGESTED_VOTE. Composite FKs `(telegramChatId, groupId)` → TelegramChat and
  `(playerId, groupId)` → Player make cross-Group rows impossible. OWNER/ADMIN
  only (`/channels/telegram/[ref]/players`); MEMBER 404.
- **Suggestions:** linked voters (TelegramUserLink → Player) who answered
  polls posted in the chat and are not in its scope; adding is explicit.
  Unlinked voters stay provider-only; no Player is ever invented.
- **`Match.telegramChatId`** — the selected chat (OWNER/ADMIN,
  `/matches/[matchId]/telegram-chat`, validated to be a connected chat of the
  Group). Context only — TelegramPoll/MessageDelivery record actual sends.
- **Roster presentation** (`src/lib/matchRosterScope.ts`): with a chat
  selected, the workspace lists the chat's scope + anyone with Match state
  (attendance/override, selection, published teams) + players the organizer
  adds; "Show all Group players" lists everyone. Never an eligibility rule;
  attendance stays Match + Player and a linked vote counts from any chat.
- **Connection lifecycle:** soft disconnect (`TelegramChat.disconnectedAt`)
  keeps polls, deliveries and scope; reconnecting the same chat to the same
  Group reactivates that row; a chat is ACTIVE in one Group at most (partial
  unique `TelegramChat_chatId_active_key`), one row per (chat, Group); an
  active chat of another Group is refused; a chat disconnected from A may be
  connected to B with B's own code as a NEW row (A keeps its history) —
  nothing ever moves between Groups. `my_chat_member` left/kicked marks the
  binding disconnected; re-adding the bot does not reconnect by itself.
  A new bind code expires the Group's older unused codes. Sends use
  connected chats only.

## M9-C — Match Player Experience (decisions as built, 2026-10-03)

- **The Match URL is canonical for Match-based published teams:**
  `/g/[org]/[group]/m/[matchId]` (`src/lib/matchPage.ts`). The server
  resolves org → Group → Match (the Match must be that Group's); every
  failure is the same 404. The Group history page stays for legacy/by-date
  teams and browsing.
- **Access follows Group visibility** (no new tokens, no migration):
  PUBLIC → anyone; PRIVATE → signed-in organization members (OWNER/ADMIN/
  MEMBER) or a Player of the Group claimed by the signed-in User
  (`resolveGroupForViewer`); LINK → `/share/m/[matchId]#<token>` with the
  Group's existing revocable, hash-only GroupShareLink (token only in the
  URL fragment, POSTed to `/api/share/match`; no-store, noindex) — the
  canonical URL also works there for members / claimed Players. A share link
  never opens a PRIVATE Group. Match pages are noindex and send no Referer.
- **Telegram identity is NOT browser authentication.** A link click proves
  nothing about who clicked; no page trusts a Telegram id/username from the
  URL. TelegramUserLink stays bot identity (and a future account-linking
  path, e.g. a verified Telegram login/Mini App evaluated separately).
- **DTO** (`PlayerMatchView`, allow-list): group/org name, sport label,
  date, start time, venue, status, team numbers, player display names and
  role labels. No Player/User ids, ratings, stamina, metrics/analysis,
  Telegram data or delivery data. Teams come only from the Match's
  published TeamGeneration (never a preview, "latest" or by date);
  "Teams have not been published yet." otherwise; canceled/completed states.
- **"View teams online"** for Match teams links to THAT Match (the posted
  generation's matchId): PUBLIC → canonical URL; LINK → the organizer's
  current share link re-used as `/share/m/<id>#token` (validated active for
  the Group; posting never mints credentials); PRIVATE → no link (unchanged).
  Legacy teams keep the Group page. The delivery content hash still excludes
  the link, so the URL change does not make posted teams look "updated".
- Organizer Match view shows the player page; `/me` links to the next
  Match page. Optional "Sign in" line for anonymous viewers (no claim flow
  from the page — claims stay organizer-issued).
- Remaining id exposure (M13): the Group history/print pages still use
  TeamGeneration ids in print links; Match ids are the URL identifier.
  No public surface exposes Player ids.

## M9-D — Result, MVP & AI Recap (decisions as built, 2026-10-03)

**SAVE ≠ PUBLISH ≠ SEND.** Saving stores organizer-only data; publishing
shows it on the Match page; only explicit OWNER/ADMIN actions talk to
Telegram ("Start MVP Vote" posts one poll; "Post Result / Announce MVP /
Post Recap" post one message each). Nothing cascades; AI never publishes or
sends. Services live in `src/lib/postGame.ts` (one route,
`/matches/[matchId]/post-game`, action-discriminated) so a future agent can
call the same functions.

- **Schema (migration #20, additive):** `MatchResult`, `MatchMvp`,
  `MatchMvpVote`, `MatchRecap` (each Match-keyed, never Telegram-owned) and
  MessageEventType `MVP_POLL_POSTED`, `MATCH_RESULT_POSTED`, `MVP_ANNOUNCED`,
  `MATCH_RECAP_POSTED`.
- **Result:** one generic non-negative integer score (≤ 999) per PUBLISHED
  team number (multi-sport; team names can hang off the same key later).
  Draft until published; publishing completes a SCHEDULED Match; a
  correction stays published and is reflected on the page; Telegram only via
  explicit "Post Updated Result" (content hash). Ties show "Draw".
- **MVP:** candidates = published-team participants (snapshot ids, so
  history survives roster changes). Rule: only participants vote (Telegram
  user → TelegramUserLink → Player), never for themselves (a self-vote
  clears that Player's vote), one current vote per Player (changes replace,
  retractions clear, malformed answers ignored), unlinked voters never count.
  Requires a published result and the Match's connected Telegram chat.
  Telegram polls: non-anonymous, single choice, ≤ 10 options (Bot API docs
  disagree between 10 and 12; 10 is safe) — above that the organizer picks an
  explicit shortlist. Close = replay stored answers, freeze, stopPoll.
  Winner = highest valid count; ties are never silent: co-MVPs or an
  organizer tie-break, recorded in `MatchMvp.decision`. Organizers see
  aggregate counts only (never who voted for whom). MVP polls never feed
  attendance and attendance polls never feed MVP.
- **Recap:** deterministic fact recap always available. AI (optional,
  server-only `src/lib/ai/openai.ts`; `OPENAI_API_KEY`, `OPENAI_MODEL`
  default `gpt-4o-mini`, `OPENAI_BASE_URL`; 15 s timeout) receives ONLY an
  allow-listed facts object (`buildRecapFacts`: sport, date, venue, team
  labels + scores, winner/draw computed by the app, published MVP names,
  participant count). Output is sanitized to plain text, ≤ 1,200 chars and
  rejected if it states a different score; any failure returns the standard
  recap as fallback. The AI draft is returned for review (kept as
  `generatedContent`), never saved as the recap; saving records the source
  (AI / AI_EDITED / DETERMINISTIC / MANUAL).
- **Match page** adds (published only): Final Result, Player(s) of the
  Match, Match Recap — no drafts, votes, voters, AI metadata or ids.
- **Canceled Matches** accept no post-game action.
- **Deferred:** web MVP voting fallback (schema supports `WEB` votes),
  WhatsApp, player statistics/scorers, standings, automation/approval
  agent (M10.5), weather-aware messages.

## Lovable / Product UX Redesign Backlog (recorded 2026-10-03, for M12)

Functional-but-plain UI is intentional until the M12 redesign (with
Lovable). Not to be polished piecemeal:

- Admin layout and navigation (Group workspace vs Match workspace vs
  Communication Channels; long single-column pages).
- Match workspace layout: attendance table and Teams checkbox chips list the
  same players twice; Telegram group selector sits among attendance buttons;
  scope management is a plain "Add to group / In group · remove" link column;
  suggestions are an inline link list; "+ Add another player" is a bare
  select.
- Published vs preview presentation, Balance panel and button hierarchy
  (Generate/Publish/Clear/Post).
- Communication Channels visual design (connected/disconnected states,
  connect instructions, chat titles).
- Player-selection design for large rosters (search, filters, grouping).
- Empty states, loading states and inline status messages.
- Mobile/responsive layout of tables and controls.
- Card design, colors, typography, backgrounds (soccer-themed background
  image), branding.
- (M9-D) Post-game panel: Result/MVP/Recap stacked boxes, raw number inputs,
  plain vote-count list, tie-break buttons, shortlist checkboxes, message
  previews before posting (none today), AI recap editing UX (no diff/undo),
  Match page result/MVP/recap layout and mobile layout.
- (M9-C) Player Match page: plain card/table, no navigation between Match,
  Group history, Matches list and Players; no "my team" highlight; sign-in
  line styling; LINK-group share-link paste field in the Match workspace is a
  bare input; onboarding/claim journey from a Match page.

## M9 — channel-neutral match lifecycle (decisions recorded 2026-10-01)

The lifecycle belongs to Team Balance Pro, not to Telegram; Telegram is the
first channel adapter (WhatsApp in M10):

```text
attendance → teams → game → result → MVP voting → MVP announcement → recap → public match page
```

- Attendance options: ✅ Playing · ❌ Not playing · 🤔 Maybe. "Maybe" is not
  confirmed and is never included automatically in generation.
- CORE: attendance, teams announcement, explicit result publication, MVP
  voting, MVP announcement, public match page.
- HIGH VALUE: one deterministic pre-game balance fact, match recap, eventual
  streak/milestone line.
- Fun content is folded into useful messages — no standalone spam. Default
  activity: **Standard** (essential lifecycle messages + at most one relevant
  fun line).
- Saving/editing a score never sends anything; publishing is explicit; AI
  never sends automatically.
- Sport vocabulary and `resultFormat` come from the SportDefinition (M7).
- **Share to WhatsApp** for teams/result/MVP links via the organizer's normal
  WhatsApp share flow — no API integration, no phone numbers stored.
- New domain concepts (attendance events/responses, results, MVP) are
  introduced in M9 above the existing Telegram tables, which stay as-is.

### M9 — Telegram Group connection experience (requirement recorded 2026-10-01)

Observed in the M7 basketball smoke: a new Group shows "No registered
Telegram chats available for this Group." That is correct isolation but
incomplete UX — today a Telegram chat can only be bound by ops/database work.
M9 must provide self-service setup per Group, e.g.:

```text
Communication Channels
Telegram   Not connected            [ Connect Telegram Group ]
Telegram   Connected · Thursday Basketball   [ Manage ] [ Disconnect ]
```

The organizer is guided to add the existing Team Balance Pro bot to their
Telegram group and securely bind that chat to the right Team Balance Pro
Group. The flow must:

- require an authenticated OWNER/ADMIN of that Group's Organization;
- bind the TelegramChat to exactly that Group (proof via a one-time,
  hash-stored code or deep link — never a bare /chatid);
- prevent cross-tenant binding and accidental reassignment of a chat already
  bound to another Group;
- show the connected Telegram group's name; never expose raw chat ids
  unnecessarily;
- allow safe disconnect/reconnect;
- work for every sport (Soccer, Basketball, Volleyball, American Football,
  Other) without developer or database intervention.

**Invariant — Telegram group isolation:** a Team Balance Pro Group's Telegram
connection never applies automatically to another Group (e.g. Indoor Soccer →
Telegram group A, Pickup Basketball → Telegram group B). A new Group never
inherits another Group's chats; the empty Telegram section in the basketball
smoke confirms this.

**Rule — Publish ≠ Send:** publishing teams/results/MVP updates Team Balance
Pro only. Posting to Telegram (or any channel) is always a separate, explicit
organizer action (e.g. Post Teams, Publish Result to Telegram, Start MVP Vote,
Announce MVP, Post Match Recap — names refined in M9). Nothing is ever posted
automatically because an organizer generates, regenerates, edits, publishes,
saves a score or changes an MVP.

**Channel-neutral direction:** the Group UI evolves toward a "Communication
Channels" section listing Telegram and WhatsApp as Connected / Not connected.
M9: Telegram connection UX, channel-neutral lifecycle, Telegram-first
delivery, Share to WhatsApp. M10: real WhatsApp integration, GroupChannel /
channel architecture if still appropriate, WhatsApp identity, multi-channel
delivery. No GroupChannel or WhatsApp work before then.

## M10 — WhatsApp & Expanded Communications (planned)

- `GroupChannel` (a Group has channels; one primary/default initially),
  WhatsApp identity (provider-scoped ids, minimal/no raw phone storage),
  Meta WhatsApp Cloud API integration (official APIs only), multi-channel
  delivery through `MessageDelivery` (one row per channel/destination,
  independently recoverable). The official WhatsApp Groups API cannot run a
  bot inside a typical pickup group (business-created groups, ≤8
  participants, no interactive messages), so WhatsApp interaction is 1:1
  opt-in plus share links and web fallback pages.

## M10.5 — Organizer Agent & Match Automation (planned)

Works ABOVE the match lifecycle and channel architecture (M9/M10 first);
never Telegram-specific:

```text
Organizer Agent → match lifecycle → approved communication → Telegram / WhatsApp / future channels
```

- **Scheduled match workflow** configured by OWNER/ADMIN, e.g. game Wednesday
  8:00 PM; attendance poll Tuesday 8:00 AM; poll close/import Tuesday 8:00 PM;
  generate after the attendance cutoff; team posting requires organizer
  approval; optional game-day update Wednesday afternoon. Exact UI is future
  work.
- **Agent flow**: schedule → attendance poll → wait for cutoff → import
  attendance → generate (balance-v2) → deterministic balance analysis →
  prepare suggested teams → request OWNER/ADMIN approval → publish/post after
  approval. **Human approval is the default**; autonomous publishing is not
  designed (a future opt-in auto-publish would be evaluated separately).
- **Game-day weather (optional)**: real weather for the match location and
  time, e.g. "Rain is expected around kickoff. Don't forget a jacket or
  umbrella." Invariant: **the weather provider is the factual source; AI only
  words it** — AI never invents temperature, rain, snow, wind, storms or
  forecasts. Organizer setting such as Game-day updates: OFF / INFORMATIONAL /
  FUN.

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

- **Generation Variety / "More variety"** (found in the M8 review): Regenerate
  rarely yields a different split (e.g. 4 distinct splits in 200 runs on a
  realistic 14-player roster) because randomness only breaks exact ties.
  Possible approach: role-safe, quality-neutral post-processing swaps outside
  the generator. Changing generation itself would mean `balance-v3` and a
  deliberate soccer-parity decision. Not in M8-A.
- (M7 follow-up) Organizer rule-strength editor (Strong/Prefer/Off) for role
  rules; registry defaults apply until then.
- (M7 follow-up) The site background image (`/SoccerTeam.jpg`) is
  soccer-themed; replace with a neutral visual in M12.
- Legacy pre-allow-list TeamGeneration snapshots contain Telegram fields;
  public/metrics code never reads them raw. Consider a reviewed scrub (M13).
- Drop the legacy TelegramPoll posting columns after M6-B bake-in.
- Telegram 4096-character message handling.
- Drop the unused legacy `Player.telegram*` columns.
- Upstash rate limiting not configured; password reset; multi-session
  revocation (M13).
- Stale pre-2D.7 ops scripts (outside the repo; do not use).
- Vercel Prisma advisory-lock (P1002) deploy risk.

## Resolved in M9-B

- Same-day Match teams (TeamGeneration identity by Match; migration #19).
- Hard-delete Telegram disconnect → soft disconnect with reactivation.

## Resolved in M9-A

- Secure TelegramChat registration → self-service connection with a one-time
  code and Telegram-admin verification.
- Telegram `/poll` organizer authorization → `/poll` retired.
- MEMBER Telegram identity visibility → all Telegram endpoints OWNER/ADMIN
  (server-enforced 404).
- MEMBER Link/Remove action visibility → hidden for MEMBER.
- Publish ≠ Send → enforced structurally and by tests.
- Public Player id privacy → removed from the public players API.

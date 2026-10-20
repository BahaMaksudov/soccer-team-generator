# M13A — Group invitations, manual membership approval, Telegram RSVP protection

Status: implemented locally on `feature/m13a-group-invitations` (not deployed).

## 1. Phase 0 — website attendance is refused for Telegram matches

Before M13A a signed-in player could answer on **/me** (source `WEB`) for any match of
their group — including Telegram matches — and the newest answer wins, so a website
answer could replace a Telegram poll vote.

Now:

- `setOwnAttendance()` (`src/lib/matches.ts`) and the M12B personal-link answer
  (`answerPersonal()`) decide **inside their write transaction**:
  1. lock the Match row — `lockMatchForAnswer()` = `SELECT … FOR UPDATE`;
  2. `attendanceMode(groupId, matchId, tx)` — the one M12B decision, now able to read
     through the transaction;
  3. only for `web` record the answer.
- Inserting a `TelegramPoll` for the match takes `FOR KEY SHARE` on the Match row
  (foreign key) and assigning a Telegram chat updates the row, so a poll posted
  concurrently either commits first (and the check sees it) or waits until the answer
  is committed. Proven with real races in `src/integration/m13a.itest.ts`.
- API: `POST /api/account/matches/[matchId]/attendance` → **409**
  `{ code: "TELEGRAM_MATCH", error: "Attendance is managed through the Telegram poll. Please submit or update your response in Telegram." }`.
- /me: Telegram matches show that sentence (and the current answer, read-only) instead
  of the Playing / Maybe / Not playing buttons. A stale page that still shows buttons
  gets the 409 and switches to the instruction.
- Unchanged: organizer overrides, Telegram webhook / sync, poll closing, Game Day
  Update, team publishing, existing attendance rows.

Not serialized (documented limitation): reconnecting a previously disconnected Telegram
chat or a plan change can turn a match into a Telegram match without touching the Match
row. Answers recorded before that remain; later Telegram votes still win (newest wins).

## 2. Architecture

- **Membership stays `Player.userId`** (no new membership table). A user is a player
  member of a group when a Player of that group is linked to their account. My Games,
  group page access (`groupAccess.ts`) and own attendance already use it.
- **Join requests ask; organizers decide.** Approval links the applicant to an existing
  unclaimed Player, or creates a new Player for them. Never automatic, never by name or
  email similarity.
- Joining never creates an `OrganizationMembership` (no organizer or MEMBER access).

## 3. Data model (additive migration `20261125120000_m13a_group_join`)

| Model | Purpose |
| --- | --- |
| `GroupJoinLink` | `organizationId, groupId, tokenHash @unique, createdByUserId?, createdAt, expiresAt, revokedAt?` |
| `GroupJoinRequest` | `organizationId, groupId, userId, joinLinkId?, firstName, lastName, status, playerId?, decidedByUserId?, decidedAt?, createdAt, updatedAt` |
| `GroupJoinRequestStatus` | `PENDING, APPROVED, REJECTED, CANCELED` |

- One PENDING request per (group, user): partial unique index
  `GroupJoinRequest_groupId_userId_pending_key` (SQL in the migration).
- Deletes: group → links and requests cascade; user → their requests cascade (creator /
  decider references are SET NULL); player / link deleted → request keeps its history
  (SET NULL).
- Nothing existing is changed or backfilled.

Rollback: SQL in the migration header. Older code never reads these tables, so leaving
them in place after an application rollback is harmless.

## 4. Join link lifecycle

- 32 random bytes (base64url), only the SHA-256 stored, in the URL **fragment**
  (`/join#<token>`) — never in a request URL, access log or Referer.
- One active link per group: generating a new one revokes the previous one.
- Default expiry 30 days (1–90 accepted by the API).
- Revoking stops **new** requests only. Requests already filed through it stay PENDING
  and the organizer decides them (reject them if a link leaked).
- The raw link is shown to the organizer **once**. Lost it → generate a new one.

## 5. Join request lifecycle

`PENDING` → `APPROVED` (organizer; `playerId` set) / `REJECTED` (organizer) /
`CANCELED` (the applicant). A rejected or canceled applicant may file a new request
(subject to the limits).

Requirements to file: signed in, **verified email** (`requireSessionUser`), a valid,
unexpired, unrevoked link, not already a member, no pending request for the group.

Limits (database-backed): 10 requests per user per day, 50 pending requests per group.
Upstash per-address limits (`join-read`, `join-write`) are optional and inactive without
Upstash configuration.

## 6. Manual approval

The organizer sees the applicant's name, **verified account email** (organizers only),
request date and status, the group's **unclaimed** Players, and "Approve as new player".

- **Link existing**: per-request lock + per-Player lock (`player-claim:<id>`, the same as
  claim links). The Player must belong to the group and be unclaimed; the applicant
  must not already be linked in the group (`Player @@unique([groupId, userId])` backs
  it up). Outstanding claim links for that Player are revoked.
- **Create new**: the same validation (`playerCreateSchema`, sport role check) and plan
  limit (`assertCapacity("activePlayers")`, 402 `PLAN_LIMIT`) as "Add player", through the
  shared `insertPlayerInTx()`.
- **Reject**: records who and when; creates or links nothing. The applicant sees a
  neutral status.

## 7. Authentication

- Google Sign-In and verified email/password accounts are reused unchanged. No
  magic links, no automatic account linking or merging.
- Sign-in / sign-up / verification return to plain `/join`. **The token is never put in
  a callback URL.** The page stores it in `localStorage` for at most one hour (it also
  survives the tab the verification email opens). The page removes it from the address
  bar and deletes it once a request is filed or the link is unusable.
- Google OAuth is documented as in **Testing** mode: only listed test users can sign
  in with Google until the app is published (not changed by M13A). Players can still use
  email/password with verification.

## 8. Security controls

- Public preview (`POST /api/join`): JSON body, `no-store`, `noindex`, `no-referrer`.
  It shows the group name, organization and sport only. Expired and revoked links
  reveal nothing; an unknown token gets a 404.
- State-changing applicant routes: JSON + same-origin (`isSameOrigin`), session gate in
  middleware and in the handler.
- Organizer routes: `requireTenantContextForSlugs` + `managersOnlyResponse` on every
  request. MEMBER, foreign or unknown → generic 404.
- `/join` is noindex (`next.config.js`, `robots.ts`) and never auth-gated (`chrome.ts`).

## 9. Tenant isolation

Every organizer query is scoped by the URL-resolved `activeGroup.id`. A request or
player of another group (same or other organization) gets a 404 or `PLAYER_NOT_FOUND`.
New group foreign keys are listed in `tenantIsolation.itest.ts`.

## 10. Telegram isolation

M13A changes none of: Telegram webhook, poll creation, answer sync, Game Day Updates,
poll closing and notices, team publishing, entitlements, Telegram links. Joining a
Telegram group gives the player /me access, where Telegram matches are poll-only.

## 11. API

| Method | Path | Who |
| --- | --- | --- |
| GET / POST | `/api/admin/o/[org]/g/[group]/join-links` (`create`, `revoke`) | OWNER/ADMIN |
| GET | `/api/admin/o/[org]/g/[group]/join-requests` | OWNER/ADMIN |
| POST | `/api/admin/o/[org]/g/[group]/join-requests/[requestId]` (`approve` + `playerId` / `newPlayer`, `reject`) | OWNER/ADMIN |
| POST | `/api/join` (preview) | anyone with the token |
| POST | `/api/join/request` | signed in, verified |
| POST | `/api/join/cancel` | the applicant |
| POST | `/api/account/matches/[matchId]/attendance` | 409 `TELEGRAM_MATCH` for Telegram matches |

## 12. UI

- Organizer: Players page → **Invite players** card (generate, copy, turn off the link;
  pending requests: approve and link, approve as a new player, or reject; recent
  decisions).
- Player: `/join` (states: invalid, expired, revoked, sign in, verify email, request
  form, waiting for approval, member, not approved). `/me` → **Group requests** (pending
  with cancel, recent outcomes) and the Telegram poll-only instruction.

## 13. Tests

- `src/integration/m13a.itest.ts` covers Phase 0 (including real lock races) and links,
  requests, approval, concurrency, plan limit, revocation policy, and tenant and role
  isolation.
- `src/lib/__tests__/closedAttendanceUi.test.ts` covers /me Telegram rendering.
- Updated: `closedAttendance.itest.ts` and `m9a.itest.ts` (website answers on Telegram
  matches are now refused), `tenantIsolation.itest.ts`, `adminRetirementInvariants`,
  `designSystem`, `authGate`.

## 14. M13B extension points

- `Player.email` (organizer-entered) attaches to the same Player that join approval links;
  no membership change needed.
- RSVP invitation emails deliver M12B personal links (`issuePersonalLinks`) for web
  matches only (`attendanceMode` gate, already used here).
- Proposed Free email allowance as a configurable policy (not implemented): e.g.
  `EMAIL_RSVP_LIMITS = { FREE: { perMonth: 100, perDay: 30 }, PRO/LEGACY: { perDay: 300 } }`,
  read from configuration, enforced per organization.

## 15. Deployment prerequisites

- Production approval; the release gates as in M12B (identity, recovery point,
  additive migration check, rollback deployment).
- No environment changes required. No emails or Telegram messages are sent by M13A.

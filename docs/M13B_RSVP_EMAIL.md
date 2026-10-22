# M13B — Bulk RSVP email invitations

Status: **P1 implemented locally** (`feature/m13b-p1-player-emails`). Nothing sends email.
Later phases are designed below and need approval one by one.

## Approved product decisions (final for M13B)

| Topic | Decision |
| --- | --- |
| Free allowance | 100 RSVP recipient emails per calendar month and 20 per calendar day, per organization |
| Paid / LEGACY allowance | 500 per month and 50 per day, per organization |
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

## Open issues / risks

- Consent: organizers enter addresses (including guardians') without the recipient confirming. Unsubscribe
  (P3) and organizer attestation in the send flow (P2/P4) are the mitigations. Legal review of guardian /
  minor data was declined for the legal pages; the same risk applies here.
- Organizers can't yet see a linked account's address (only that one exists and is verified). That is
  intentional, but they may want to know where invitations will go. The preview (P2) can show the masked
  destination (for example `p•••@example.com`) if approved.
- DMARC is not configured for `mail.teambalancepro.com` / `teambalancepro.com`. It is required before P4 goes
  live.

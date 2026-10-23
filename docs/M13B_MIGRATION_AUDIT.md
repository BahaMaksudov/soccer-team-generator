# M13B — Production migration readiness report (read-only audit)

**Scope:** the M13B migrations on `feature/m13b-p1-player-emails`, applied after Production's last migration
(`f059181`). **Nothing was run against Production or Preview.** The analysis comes from the SQL files and
from fresh replays on disposable local databases.

There are **ten** migrations. The P8B.1 retry-window fix added the tenth; the earlier plan said nine.

## Summary

| # | Migration | Changes existing tables? | Existing-data impact | Backfill | Lock risk | Downtime risk |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `20261201120000_m13b_p1_player_contact_email` | `Player` +3 nullable columns, +CHECK | None (all NULL) | No | CHECK validation scans `Player` under ACCESS EXCLUSIVE | Very low (small table) |
| 2 | `20261205120000_m13b_p3_email_suppression` | No (3 new tables, FKs to `Organization`) | None | No | Brief SHARE ROW EXCLUSIVE on `Organization` per FK | Negligible |
| 3 | `20261210120000_m13b_p4_rsvp_sending` | `PersonalAttendanceLink` +1 NOT NULL column with constant default | Every existing link becomes `MANUAL` (intended) | Implicit (default) | ACCESS EXCLUSIVE on `PersonalAttendanceLink` (metadata only, no rewrite); brief FK locks on `Organization`, `Group`, `Match`, `User`, `Player`, `PersonalAttendanceLink` | Very low |
| 4 | `20261212120000_m13b_p4_quota_ledger` | No (new table) | None | Yes: from `RsvpInvitation` (empty in Production → no rows) | Brief FK lock on `Organization` | Negligible |
| 5 | `20261215120000_m13b_p5_send_attestation` | `RsvpSend` +2, `PersonalAttendanceLink` +1 nullable column | None | No | ACCESS EXCLUSIVE, metadata only | Negligible |
| 6 | `20261220120000_m13b_p6_delivery_management` | `EmailUnsubscribeToken` +1 (default false); `Player` +2 nullable, +CHECK, +FK to `User` | None (all NULL / false) | No | CHECK and FK validation scan `Player`; FK takes SHARE ROW EXCLUSIVE on `Player` and `User` | Very low |
| 7 | `20261225120000_m13b_p7_retention` | `RsvpInvitation` / `RsvpSend` (new in #3) +1 each; enum value; index | None | No | Enum `ADD VALUE`; index on an empty table | Negligible |
| 8 | `20261228120000_m13b_p8a_support_opt_out` | Enum value only | None | No | Brief | Negligible |
| 9 | `20261230120000_m13b_p8a1_delivery_pacing` | `RsvpInvitation` +1 nullable; new one-row table | None | No | Metadata only | Negligible |
| 10 | `20261231120000_m13b_p8b1_idempotency_window` | `RsvpInvitation` +1 nullable | None | No | Metadata only | Negligible |

**Overall:**
- All ten are additive. No existing column is dropped, renamed or retyped, and no existing row is updated or
  deleted.
- The two CHECK constraints on `Player` are the only steps that scan an existing table while holding a
  write-blocking lock. That table is small (one row per roster player).
- Expected total lock time: well under a second at current scale.
- **Recommendation:** run a read-only `SELECT count(*) FROM "Player"` on the Neon snapshot before migrating
  **[APPROVAL]**, to confirm the scale assumption. Above about 1M rows, split each CHECK into `NOT VALID` +
  `VALIDATE CONSTRAINT`.

## Per-migration detail

### 1. `m13b_p1_player_contact_email`
- **Changes:**
  - enum `PlayerContactType` (PLAYER, GUARDIAN);
  - `Player.contactEmail TEXT`, `Player.contactEmailType`, `Player.contactEmailUpdatedAt` (all nullable);
  - CHECK `Player_contactEmail_type_together` (email and type are both null or both set).
- **Existing data:** none changed. New columns are NULL, so the CHECK is satisfied by every existing row.
- **Locking:** `ADD COLUMN` (nullable, no default) is metadata only. `ADD CONSTRAINT … CHECK` scans `Player`
  under ACCESS EXCLUSIVE, which briefly blocks reads and writes of `Player`.
- **Rollback:**
  1. drop the constraint, then the three columns, then the type;
  2. any contact data entered after release is lost.

### 2. `m13b_p3_email_suppression`
- **Changes:**
  - enums `GlobalSuppressionReason`, `EmailOptOutSource`, `EmailPurpose`;
  - tables `GlobalEmailSuppression` (unique email), `OrganizationEmailOptOut` (unique organization + email,
    FK → Organization, cascade) and `EmailUnsubscribeToken` (unique tokenHash, index on organization + email,
    FK → Organization, cascade).
- **Existing data:** none.
- **Locking:** FK creation takes SHARE ROW EXCLUSIVE on `Organization`; validation is instant on empty tables.
- **Rollback:** dropping these tables after the pilot deletes the opt-out and suppression records. **Not
  recommended**: those records stop people being emailed again.

### 3. `m13b_p4_rsvp_sending`
- **Changes:**
  - enums `PersonalLinkChannel`, `RsvpSendKind`, `RsvpDeliveryStatus`, `RsvpRecipientType`;
  - `PersonalAttendanceLink.channel NOT NULL DEFAULT 'MANUAL'`;
  - tables `RsvpSend` and `RsvpInvitation` with their unique / plain indexes and FKs (Organization, Group,
    Match cascade; User, Player, PersonalAttendanceLink, EmailUnsubscribeToken set null).
- **Existing data:** every existing personal link reads as `MANUAL`. That is intended: manual links keep
  working, and emailed links are tracked separately.
- **Locking:** a constant default needs no table rewrite (PostgreSQL ≥ 11; Neon runs a newer version), so the
  ACCESS EXCLUSIVE lock is brief. FK creation takes brief SHARE ROW EXCLUSIVE locks on `Organization`,
  `Group`, `Match`, `User`, `Player` and `PersonalAttendanceLink`, which momentarily blocks writes to them.
- **Rollback:** drop both tables, the column and the enums. Sends and invitations are lost.

### 4. `m13b_p4_quota_ledger`
- **Changes:** table `RsvpEmailUsage` (primary key organization + day, CHECK consumed ≥ 0, FK → Organization
  cascade).
- **Backfill:** `INSERT … SELECT` from `RsvpInvitation` (SENT / UNCERTAIN). In Production that table is
  created empty by #3 in the same release, so **zero rows**.
- **Rollback:** drop the table. Usage history would be lost, and the quota would then count only live
  invitations.

### 5. `m13b_p5_send_attestation`
- **Changes:** `RsvpSend.attestedAt`, `RsvpSend.confirmedCount` and `PersonalAttendanceLink.replacedAt`, all
  nullable.
- **Locking:** metadata only.
- **Rollback:** drop the columns.

### 6. `m13b_p6_delivery_management`
- **Changes:**
  - `EmailUnsubscribeToken.oneClickOnly BOOLEAN NOT NULL DEFAULT false`;
  - `Player.contactAuthorizedAt` and `Player.contactAuthorizedByUserId` (nullable);
  - CHECK `Player_contact_authorization_requires_contact`;
  - FK `Player_contactAuthorizedByUserId_fkey` → User (set null);
  - table `EmailWebhookEvent` (unique provider + event id).
- **Existing data:** none. Contacts entered before this migration (none in Production, since #1 ships in the
  same release) would start unconfirmed.
- **Locking:** the CHECK scans `Player` under ACCESS EXCLUSIVE. The FK scans `Player` (all NULL) under SHARE
  ROW EXCLUSIVE on `Player` and `User`.
- **Rollback:** drop the table, the constraints and the columns.

### 7. `m13b_p7_retention`
- **Changes:**
  - enum value `GlobalSuppressionReason.RECIPIENT_REQUEST`;
  - `RsvpInvitation.anonymizedAt` (Prisma name `identifiersRemovedAt`);
  - `RsvpSend.retentionHoldUntil`;
  - index on `RsvpInvitation(anonymizedAt, matchId)`.
- **Locking:** `ALTER TYPE … ADD VALUE` runs inside the migration transaction. That is allowed in PostgreSQL
  ≥ 12, and the value isn't used in the same transaction. The index is on a table that is empty at release.
- **Rollback:** the enum value can't be dropped in place (a type rebuild would be needed). Columns and index
  can be dropped.

### 8. `m13b_p8a_support_opt_out`
- **Changes:** enum value `EmailOptOutSource.SUPPORT_REQUEST`.
- **Rollback:** it can't be dropped in place, and is harmless if unused.

### 9. `m13b_p8a1_delivery_pacing`
- **Changes:** `RsvpInvitation.notBefore` (nullable) and table `RsvpDeliveryPacer` (one row, CHECK `id = 1`,
  no personal data).
- **Rollback:** drop the table and the column.

### 10. `m13b_p8b1_idempotency_window`
- **Changes:** `RsvpInvitation.idempotencyKeyFirstUsedAt` (nullable).
- **Rollback:** drop the column.

## Procedure notes

- **Order:** `prisma migrate deploy` applies them in filename order. Each runs in its own transaction, and a
  failure stops the sequence with earlier migrations kept. They can be re-run safely after a fix.
- **Before:** take a Neon branch / snapshot **[APPROVAL]**. Check `_prisma_migrations` in Production ends at
  the last pre-M13B migration (read-only, **[APPROVAL]** to connect).
- **During:**
  - the existing app (`main`) keeps working on the migrated schema, since all changes are additive and new
    columns are nullable or defaulted;
  - deploy code and migrations together, following the repository's release procedure;
  - RSVP delivery stays `disabled`.
- **After:** check `_prisma_migrations` (ten new rows), then smoke-test sign-in, the match page, attendance,
  a Telegram poll and an account email.
- **Rollback:** code first (redeploy the previous release, R). Undoing schema changes is hand-written and not
  recommended (I). See each migration's header.
- **Local verification:** a fresh replay of all 50 migrations on a disposable database matched
  `prisma/schema.prisma` exactly (`prisma migrate diff --exit-code` = 0) for every M13B phase, P8B.1
  included.

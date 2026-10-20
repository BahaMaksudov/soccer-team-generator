# M12B — one attendance workflow per match

## Workflows

| Match | How players answer | Organizer tools |
| --- | --- | --- |
| **Telegram** — has an attendance poll, or a connected Telegram group is selected and the plan allows Telegram | Vote in the Telegram poll | Override; Close attendance (closes the poll too) |
| **Website-only** — everything else | Their own **personal attendance link** (`/attend#<token>`) | Generate / copy / regenerate / revoke links; override; Close attendance |

`attendanceMode()` in `src/lib/attendanceClosure.ts` is the single decision. Personal
links are refused (organizer: 409 `TELEGRAM_MATCH`; player: "vote in the poll") for
Telegram matches, so a match never has two competing workflows.

The shared Match Link (`/share/m/<id>#<token>`) is **view-only**: its answer endpoint
returns 410 `MATCH_LINK_READ_ONLY`. It explains where to answer.

## Personal links

- 32 random bytes in the URL **fragment** (never in request URLs, logs or Referer);
  only the SHA-256 hash is stored (`PersonalAttendanceLink.tokenHash`).
- One player, one match, one group/organization. The player comes from the stored row.
- Valid while: not revoked, group and player active, player on the match roster, match
  scheduled, attendance open (closes at the deadline or on close), website-only match.
- Regenerating revokes the previous link. Links are **never sent automatically** —
  organizers copy and distribute them.
- Rate limits: 20 answers / 10 min per link (database), plus the optional per-IP limit.
- Answers are recorded as source `PERSONAL_LINK`; organizer overrides keep precedence.

## Closing attendance (one path)

`closeMatchAttendance()` is used by Close attendance, Close Telegram poll, the deadline
and Post teams: final Telegram sync → `attendanceClosedAt` → stop every open poll (no DB
transaction held during Telegram calls) → the one-time "✅ Poll is closed" notice per
verifiably closed poll (deduped by the existing `POLL_CLOSED_NOTICE` delivery + per-poll
lock). No notice after an unconfirmed/refused stop; none on Free / expired trials.
The **deadline** sends the notice only with `ATTENDANCE_DEADLINE_NOTICE=on` (off by default).

## Matches created before M12B

- No data is migrated or changed. Existing answers (including historic `LINK` answers from
  the old shared-link name picker) stay as recorded and keep counting.
- Matches with an attendance poll are Telegram matches. Others are website-only: players
  who used the shared link now need a personal link from the organizer.
- Polls already closed before M12B without a notice get their notice once, the next time an
  organizer closes attendance / posts teams for that match (never automatically).

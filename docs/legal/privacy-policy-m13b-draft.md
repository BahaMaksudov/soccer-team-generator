# DRAFT — Privacy Policy changes for RSVP invitation emails (M13B)

**Status: proposal for review. Not published.** `src/app/privacy/page.tsx` is unchanged. Apply these changes
only when RSVP email delivery is approved for launch. Update the effective date on the same day.

These changes describe M13B as built (P1–P7; P7 added the 90-day retention cleanup and the privacy-request
procedure). They have not been reviewed by a lawyer. They do not claim
compliance with any specific law (for example COPPA, CAN-SPAM, GDPR or state privacy laws). Open questions
are at the end.

Each change below shows the current text and the proposed replacement, by section of the current policy.

---

## Section 2 — "Information we collect"

**Add to "Information organizers enter about players"** (after the attendance bullet):

> - **A contact email address for a player (optional).** This is either the player's own address or a parent's
>   or guardian's address, and the organizer marks which. Only the group's organizers can see it. When an
>   organizer saves or changes a contact address, they must confirm that the player or the parent / guardian
>   gave them the address, or agreed to its use, for match coordination emails. We record which organizer
>   confirmed this and when. This is the organizer's own statement: we don't verify it, and it isn't a record
>   of a parent's or guardian's legal consent. We don't collect a player's age, date of birth or other details
>   about their parent or guardian.

**Add a new subsection "RSVP invitation emails"** (after "Information from players"):

> - **For each invitation:** the match, the player, the address it was sent to, whether it was the player's,
>   a parent / guardian's or a linked account's address, and when it was queued.
> - **Delivery status:** whether our email provider accepted it, rejected it, or didn't confirm it, plus a short
>   error category with no message text. "Accepted" means the provider took the message, not that it reached
>   the inbox.
> - **Usage counts:** the number of invitation emails each organization used per day, to apply plan
>   allowances. These counts hold no addresses or names.
> - **Unsubscribe records:** that an address opted out of one organization's invitations, how (unsubscribe page
>   or one-click) and when.
> - **Suppression records:** addresses our email provider reported as permanently undeliverable (hard bounce) or
>   as having marked an invitation as spam. We don't send invitation emails to these addresses from any
>   organization.
> - **Provider event records:** the identifier and type of each delivery event our email provider sends us, so
>   no event is processed twice. These records contain no address.

**Current** (Security and technical information, tokens bullet):

> Short-lived, single-use tokens for email verification, password reset, invitations and links, stored only as
> hashes.

**Proposed:**

> Tokens for email verification, password reset, invitations, personal attendance links and unsubscribe links,
> stored only as hashes. Most are short-lived. Unsubscribe links last one year, so older emails keep working.

## Section 4 — "How we use information"

**Add:**

> - To send RSVP invitation emails when an organizer chooses to. Each email covers one player and one match and
>   lets the recipient answer Playing, Maybe or Not playing. Opening the email or a link never records an
>   answer: the recipient has to confirm on the page that opens.
> - To honor unsubscribes and suppressions, and to apply each plan's invitation allowance.

## Section 5 — "Who can see player information"

**Add to the Organizers bullet:**

> Organizers also see each player's contact email and its type (player or parent / guardian), and who confirmed
> it and when. For invitations, organizers see a masked address (for example `p•••@example.com`) and whether each
> email was accepted, failed, uncertain or skipped. They never see a linked account's full email address.

**Add to the Players bullet:**

> An invitation email and its personal page show only that player's name, the match and their own answer. Never
> other players' information.

## Section 7 — "Emails we send"

**Current:**

> - Account emails: email verification, password reset and organization invitations.
> - Organizer notifications, for example when attendance for a scheduled match is ready.
> - When enabled, reminders to organization owners about the end of the {TRIAL_DAYS}-day Pro trial (currently 90 days).
>
> We do not send marketing emails. Emails are delivered by our email provider (section 8).

**Proposed:**

> - Account emails: email verification, password reset and organization invitations.
> - Organizer notifications, for example when attendance for a scheduled match is ready.
> - When enabled, reminders to organization owners about the end of the {TRIAL_DAYS}-day Pro trial (currently 90 days).
> - **RSVP invitation emails**, sent only when an organizer sends them for a match. They go to the player's
>   contact address, a parent's or guardian's address, or the verified email of the player's linked account.
>   Each one contains an unsubscribe link and supports one-click unsubscribe from the email app. Unsubscribing
>   stops invitation emails from that organization only. It doesn't affect account or security emails, which
>   can't be unsubscribed from while you have an account.
>
> We do not send marketing emails. Emails are delivered by our email provider (section 8).

## Section 8 — "Service providers and sharing"

**Current:**

> **Resend** — sending the emails in section 7.

**Proposed:**

> **Resend** — sending the emails in section 7, including RSVP invitations. It receives each recipient's address
> and the email's content. It tells us when an email bounces permanently or is marked as spam.

## Section 10 — "Security"

**Add:**

> Unsubscribe links use random tokens of which only a hash is stored. The one-click unsubscribe address in an
> email's headers uses its own token, which can only unsubscribe and reveals nothing. Our provider's delivery
> reports are accepted only with a valid signature.

## Section 11 — "Retention and deletion"

**Add to Retention:**

> - **Invitation records:** we keep the address an invitation was sent to, and our email provider's
>   reference for it, for **90 days after the match**. After that we remove them. We keep only the delivery
>   status and dates, so the organizer's history stays accurate. We may keep them longer only while we
>   investigate a specific delivery problem. If a match is deleted earlier, its invitation records are
>   deleted with it. Daily usage counts hold no addresses and are kept for plan allowances.
> - **Players' answers are not affected** by this cleanup.
> - **Unsubscribe and suppression records** are kept indefinitely, so that we keep honoring them. They
>   contain only the address, the organization (for unsubscribes), the reason and the date.
> - **Unsubscribe links** stop working after one year. We then delete them, together with the address they
>   held. Provider event records hold no address and are kept indefinitely.

**Add to Deletion and correction:**

> - Organizers can change or remove a player's contact email at any time. Removing it also removes the record
>   of who confirmed it.
> - To stop invitation emails, use the unsubscribe link in any invitation.
> - **If you received an invitation and want us to delete your address,** email us. We remove it from:
>   - invitation records;
>   - unsubscribe links;
>   - every player contact where an organizer entered it.
>
>   Unless you ask otherwise, we keep only your address with a note that you asked not to be contacted, so
>   no organizer can send you invitations again. If you ask us to remove that too, an organizer could enter
>   your address again later. We always keep a record that an address bounced or reported spam, so we
>   don't send it more email.
> - We may need to confirm that you control the address before acting on a request about it.

## Section 13 — "Adults-only accounts and youth player profiles"

**Add:**

> - Organizers may enter a parent's or guardian's email address for a youth player so that the parent or
>   guardian receives match invitations. Invitations are addressed to them as the player's parent or guardian
>   and contain only the player's name and match details. The organizer's confirmation that they may use the
>   address (section 2) is their own statement and is not verified by us.

---

## Open questions for review (not resolved by this draft)

1. **Legal review.** This was not reviewed by a lawyer. That matters most for minors' data (COPPA and state
   laws) and for whether an organizer's attestation is enough for a guardian contact.
2. **Unsubscribes kept forever versus deletion requests.** Keeping an address so we keep honoring its opt-out
   can conflict with a request to delete it. We need a policy decision, for example keeping a hash of the
   address instead.
3. **Request logs.** The one-click unsubscribe URL (which RFC 8058 requires to be in the email header) can
   appear in our hosting provider's request logs. The token there can only unsubscribe that address from
   that organization. Mention it explicitly, or set log retention limits.
4. **Retention period.** The draft says 90 days after the match. The cleanup is built but not scheduled.
   Confirm the period, and that it runs (for example, daily) from launch.
5. **Commercial-email classification.** Invitations are transactional (organizer-initiated match coordination,
   no marketing). Confirm this classification, and the sender identification and postal address requirements,
   if any.
6. **Suppression kept after an erasure request.** By default we keep the address in the suppression list.
   Confirm that this "do not contact" record is acceptable. A salted hash would avoid storing the address,
   but needs key management: if the key is lost or changed, the record no longer matches.
7. **Identity check** for requests about an address: decide the minimum check, such as replying from that
   address.

# DRAFT — Privacy Policy changes for RSVP invitation emails (M13B)

**Status: proposal for review. Not published.** `src/app/privacy/page.tsx` is unchanged. Apply these changes
only when RSVP email delivery is approved for launch. Update the effective date on the same day.

These changes describe M13B as built (P1–P8A). P8A corrected the privacy-request procedure: a global
do-not-contact is recorded only on request, and organization unsubscribes stay per organization. It also
stopped describing the retention cleanup as "anonymization".

**Status of this draft (P8A): final candidate for owner and legal review.** Items marked **[OWNER]** or
**[LEGAL]** in the list at the end must be decided before publishing. They have not been reviewed by a lawyer. They do not claim
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
>   reference for it, for **90 days after the match**. After that we remove them.
>   - If the player is deleted sooner, we remove them at our next routine cleanup.
>   - The rest of the record stays for the organizer's history: which player it was for, whether it went to
>     the player, a parent / guardian or a linked account, and its delivery status and dates. It still
>     relates to that player, so it is still personal information. It is deleted when the match is deleted.
>   - We may keep the address longer only while we investigate a specific delivery problem.
>   - Daily usage counts hold no personal information and are kept for plan allowances.
> - **Players' answers are not affected** by this cleanup.
> - **Unsubscribe and suppression records** are kept indefinitely, so that we keep honoring them. They
>   contain only the address, the organization (for unsubscribes), the reason and the date.
> - **Unsubscribe links** stop working after one year. We then delete them, together with the address they
>   held. Provider event records hold no address and are kept indefinitely.

**Add to Deletion and correction:**

> - Organizers can change or remove a player's contact email at any time. Removing it also removes the record
>   of who confirmed it.
> - To stop invitation emails, use the unsubscribe link in any invitation.
> - **If you received an invitation and want us to delete your address,** email us. Tell us whether the request
>   is about one organization or all of them. We remove your address from:
>   - invitation records;
>   - unsubscribe links;
>   - the player contacts where an organizer entered it.
> - **Choosing to stop future invitations is up to you.** You can ask us to:
>   - only delete your address. An organizer could then enter it again later;
>   - stop that organization's invitations;
>   - stop invitations from every organization ("do not contact").
>
>   To honor that choice, we keep only your address, the organization (if it applies), what you asked for and
>   the date. We never widen an unsubscribe from one organization into a block on all of them.
> - **Some records stay even after deletion.** If you previously unsubscribed from an organization, that
>   unsubscribe stays. A record that your address bounced or reported spam also stays. Keeping these is what
>   stops further email to you.
> - We may need to confirm that you control the address before acting on a request about it.

## Section 13 — "Adults-only accounts and youth player profiles"

**Add:**

> - Organizers may enter a parent's or guardian's email address for a youth player so that the parent or
>   guardian receives match invitations. Invitations are addressed to them as the player's parent or guardian
>   and contain only the player's name and match details. The organizer's confirmation that they may use the
>   address (section 2) is their own statement and is not verified by us.

---

## Open questions for review (not resolved by this draft)

1. **[LEGAL] Legal review.** This was not reviewed by a lawyer. That matters most for minors' data (COPPA and state
   laws) and for whether an organizer's attestation is enough for a guardian contact.
2. **[OWNER/LEGAL] Unsubscribes kept forever versus deletion requests.** We keep the address only in opt-out /
   suppression records, to keep honoring them. Confirm this is acceptable under the deletion right that
   applies. The alternative is a keyed hash, which needs key management (see the engineering doc).
3. **[OWNER] Request logs.** The one-click unsubscribe URL (which RFC 8058 requires to be in the email header) can
   appear in our hosting provider's request logs. The token there can only unsubscribe that address from
   that organization. Mention it explicitly, or set log retention limits.
4. **[OWNER] Retention period.** The draft says 90 days after the match. The cleanup is built but not scheduled.
   Confirm the period, and that it runs (for example, daily) from launch.
5. **[LEGAL] Commercial-email classification.** Invitations are transactional (organizer-initiated match coordination,
   no marketing). Confirm this classification, and the sender identification and postal address requirements,
   if any.
6. **[OWNER] Default when a requester doesn't say whether to block future invitations.** Proposed: ask them;
   if there's no answer, delete only (no new block), and keep any existing unsubscribe / bounce / complaint
   record.
7. **[OWNER] Identity check** for requests about an address: decide the minimum check, such as replying from that
   address.

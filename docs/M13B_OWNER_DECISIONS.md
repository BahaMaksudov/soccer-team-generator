# M13B — owner and legal decisions before the RSVP email pilot

**Status:** for owner review. Nothing here is published or switched on. Each decision gives:
- a **recommended default** (what the code and drafts assume today);
- **alternatives** and their **consequences**;
- where applicable, **exact text** to approve. It comes from `docs/legal/privacy-policy-m13b-draft.md` (PP) and
  `docs/legal/terms-m13b-draft.md` (ToS).

**[LEGAL]** means a lawyer should confirm. This has not had legal review.

---

## D1. Guardian contacts — is the organizer's confirmation enough? [OWNER + LEGAL]

**Today:** an organizer can enter a parent / guardian address. Saving it requires ticking: "I confirm this
parent / guardian gave me this address, or agreed to its use, for match coordination emails about this player."
We record who and when. The UI says it "isn't verified and isn't a legal consent record".

| Option | Consequence |
| --- | --- |
| **A (recommended for a 1-organization internal pilot): organizer attestation, as built** | No extra build. The guardian gets an unsubscribe link in every email. The risk is that the organizer misstates permission. |
| B: guardian double opt-in (a confirmation email before the first invitation) | Stronger evidence of consent. Needs a new email type, confirm page and state (roughly one phase of work). Fewer guardians become reachable. |
| C: no guardian contacts in the pilot | Simplest. The pilot only covers players with their own or a linked account address. |

**Approve (PP §2 and §13; ToS §3):**
> "When an organizer saves or changes a contact address, they must confirm that the player or the parent /
> guardian gave them the address, or agreed to its use, for match coordination emails. We record which organizer
> confirmed this and when. This is the organizer's own statement: we don't verify it, and it isn't a record of a
> parent's or guardian's legal consent."

> "Organizers may enter a parent's or guardian's email address for a youth player so that the parent or guardian
> receives match invitations. … The organizer's confirmation that they may use the address (section 2) is their
> own statement and is not verified by us."

> "This includes permission to email a parent or guardian about their child's matches."

## D2. Organizer authorization at send time [OWNER]

**Today:** before every send, resend or retry, the organizer ticks "I'm authorized to contact these N
recipients … about coordinating this match". The time and the count are recorded.

- **Recommended:** keep as built.
- **Alternative:** make it a one-time organizer agreement per organization. That's less friction but weaker
  per-send evidence.

**Approve (ToS §3):**
> "Organizers must: only add addresses they are allowed to use for match coordination; keep them accurate, and
> remove an address when asked; send invitations only about real matches of their group."

## D3. 90-day retention [OWNER + LEGAL]

**Today:** the cleanup removes addresses and provider ids 90 days after the match, or at the next run for a
deleted player. The rest of the record stays and is still personal data. The cleanup is built but **not
scheduled**.

| Option | Consequence |
| --- | --- |
| **A (recommended): 90 days, daily run, approved schedule** | Organizers keep a season's delivery history. Addresses are gone 3 months after the match. |
| B: 30 days | Less personal data kept; less history for disputes ("did they get the email?"). |
| C: 180+ days | More history; harder to justify for minors' guardian addresses. |

Also decide: whether to schedule it before the pilot (**recommended: yes**, starting with a dry run).

**Approve (PP §11):**
> "Invitation records: we keep the address an invitation was sent to, and our email provider's reference for it,
> for 90 days after the match. After that we remove them. If the player is deleted sooner, we remove them at our
> next routine cleanup. The rest of the record stays for the organizer's history … It still relates to that
> player, so it is still personal information. It is deleted when the match is deleted."

## D4. Unsubscribe and suppression records kept indefinitely [OWNER + LEGAL]

**Today:**
- an organization unsubscribe keeps the address, organization, source and date;
- a bounce, complaint or do-not-contact record keeps the address, reason, source and date;
- both are kept indefinitely, so the address is never emailed again;
- nothing in code deletes them.

| Option | Consequence |
| --- | --- |
| **A (recommended): keep, minimal fields** | The block reliably holds. The address stays stored. |
| B: keyed hash (HMAC) instead of the address | Protects the stored address. Needs key management; losing or rotating the key silently breaks blocking. |
| C: expire after N years | Less data; old unsubscribes could lapse and the person could be emailed again. |

**Approve (PP §11):**
> "Unsubscribe and suppression records are kept indefinitely, so that we keep honoring them. They contain only
> the address, the organization (for unsubscribes), the reason and the date."

## D5. Privacy requests from recipients [OWNER + LEGAL]

**Today:** support runs `eraseRecipientEmail(address, { scope, doNotContact })` after checking the requester
controls the address. It removes the address from invitations, unsubscribe links and organizer contacts. A
"do not contact" block is recorded only on request. Existing blocks are never removed or widened.

Decisions:
1. **Identity check.** Recommended: the requester emails from that address, or confirms a code sent to it.
   The alternative is to accept any request, which risks deleting someone else's data.
2. **Default when the requester doesn't say whether to block future invitations.** Recommended: ask them; if
   there's no answer, delete only (`NONE`). The alternative, a global `GLOBAL` block by default, is more
   protective, but keeps their address when they asked for deletion.
3. **Who handles requests and how fast.** Recommended: the owner, within 30 days, using the support function.
   No self-service tool yet.

**Approve (PP §11):**
> "If you received an invitation and want us to delete your address, email us. Tell us whether the request is
> about one organization or all of them. …"
> "Choosing to stop future invitations is up to you. You can ask us to: only delete your address. An organizer
> could then enter it again later; stop that organization's invitations; stop invitations from every
> organization ("do not contact")."
> "We may need to confirm that you control the address before acting on a request about it."

## D6. Service-provider processing [OWNER + LEGAL]

**Today:** Resend sends all email, account and RSVP. It receives each recipient address and the email
content, and reports bounces and complaints by webhook.

- **Recommended:** keep Resend.
- **To check:** its data-processing terms (DPA) and sub-processors, and that sending-region data residency is
  acceptable.
- **Alternatives:** none needed for the pilot.

**Approve (PP §8):**
> "Resend — sending the emails in section 7, including RSVP invitations. It receives each recipient's address and
> the email's content. It tells us when an email bounces permanently or is marked as spam."

## D7. Hosting request logs and the one-click unsubscribe URL [OWNER]

The one-click unsubscribe URL (required in the email header) carries a narrow token in its query string, and
Vercel request logs may record it. That token can only unsubscribe that address from that organization.

| Option | Consequence |
| --- | --- |
| **A (recommended): accept, and mention it in the policy** | No change. Low impact. |
| B: shorter Vercel log retention, or a log-drain filter | Less exposure; needs configuration. |

## D8. Commercial-email classification and sender details [LEGAL]

Invitations are organizer-initiated match coordination, with no marketing. **Recommended:** treat them as
transactional / relationship messages, keep the unsubscribe, and add a sender postal address if counsel
requires one.

## D9. Reply-to address [OWNER]

**Today:** there is no reply-to, and replies go to the sender `no-reply@mail.teambalancepro.com` (verified Production `EMAIL_FROM`).

| Option | Consequence |
| --- | --- |
| **A (recommended for the pilot): a monitored support address** (for example `support@teambalancepro.com`) | Recipients can reach a human. Replies land with the operator, not the organizer. |
| B: the organizer's address | More natural for players; exposes the organizer's address and needs a per-send reply-to (code change). |
| C: none | Simplest; replies are lost. |

## D10. Publishing the legal changes [OWNER + LEGAL]

- **Recommended:** publish the Privacy Policy and Terms changes together, with a new effective date, **before**
  the first real invitation. That includes the internal pilot if any non-staff address will receive email.
- **Alternative:** an internal-only pilot (staff addresses only) before publishing. That's acceptable if no
  third party's data is processed.

---

### Quick approval sheet

| # | Decision | Recommended | Owner choice |
| --- | --- | --- | --- |
| D1 | Guardian contacts | A: attestation (internal pilot) | |
| D2 | Send-time authorization | Keep as built | |
| D3 | Retention | 90 days, daily run, schedule before the pilot | |
| D4 | Suppression records | Keep minimal fields indefinitely | |
| D5 | Privacy requests | Verify control; ask about blocking, else delete only; owner handles within 30 days | |
| D6 | Resend as processor | Keep; review its DPA | |
| D7 | One-click URL in logs | Accept and disclose | |
| D8 | Email classification | Transactional; legal to confirm postal address | |
| D9 | Reply-to | Monitored support address | |
| D10 | Legal publication | Before any non-staff recipient | |

import Link from "next/link";
import LegalPage, { LegalSection, OwnerTodo } from "@/components/legal/LegalPage";
import { LEGAL_PATHS, legalCanonical, legalIsDraft } from "@/lib/legal";
import { supportEmail } from "@/lib/support";
import { TRIAL_DAYS } from "@/lib/entitlements";

/**
 * Public Privacy Policy. Every statement describes what the application does
 * today (verified in code and Production configuration); open business / legal
 * facts are OwnerTodo markers (src/lib/legal.ts). Noindex while a draft.
 */
export const metadata = {
  title: "Privacy Policy — Team Balance Pro",
  description: "How Team Balance Pro collects, uses and protects information about organizers and players.",
  alternates: { canonical: legalCanonical(LEGAL_PATHS.privacy) },
  ...(legalIsDraft() ? { robots: { index: false, follow: true } } : {}),
};

function Contact() {
  const email = supportEmail();
  return email ? <a href={`mailto:${email}`} className="font-semibold underline">{email}</a> : <OwnerTodo id="contact" />;
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <>
          <p>
            Team Balance Pro (&quot;we&quot;, &quot;us&quot;) is a web app that helps organizers of pickup and recreational sports groups manage players, attendance and balanced teams. It is operated by <OwnerTodo id="operator">operator&apos;s legal name</OwnerTodo>. This policy explains what information the service handles, why, and the choices you have.
          </p>
          <p className="mt-2">
            Effective date: <OwnerTodo id="effective-date">date</OwnerTodo>
          </p>
        </>
      }
    >
      <LegalSection id="who" title="1. Organizers, players and who decides">
        <p>
          <strong>Organizers</strong> create an organization and groups, and enter information about their players. <strong>Players</strong> take part in those groups — with or without their own Team Balance Pro account. Much of the player information in the service (for example names and attendance) is entered and managed by the organizer of the group, who decides what to record. If you are a player and want information about you corrected or removed, you can ask your organizer or contact us (section 12).
        </p>
      </LegalSection>

      <LegalSection id="collect" title="2. Information we collect">
        <p className="font-semibold">Account information (organizers and players who create an account)</p>
        <ul>
          <li>Your name and email address.</li>
          <li>If you sign up with email and password: your password, stored only as a one-way bcrypt hash. We never store or see your password itself.</li>
          <li>Whether and when your email address was verified.</li>
          <li>If you use Google Sign-In: see section 3.</li>
          <li>Your organizations, groups and role (owner, admin or member), and invitations you send or accept.</li>
        </ul>
        <p className="font-semibold">Information organizers enter about players</p>
        <ul>
          <li>First and last name, playing position, a skill rating, a stamina value and whether the player is active, plus the communities (rosters) the player belongs to. Skill ratings and stamina are used only to balance teams and are shown to organizers only — never to players.</li>
          <li>Attendance for matches (playing, maybe, not playing), whether the answer came from the player or was set by the organizer, and when.</li>
          <li>Matches (date, time, venue, attendance deadline), generated and published teams, results, Player of the Match and match recaps.</li>
          <li>Venue names and addresses, and a map location for a venue when the organizer confirms one.</li>
        </ul>
        <p className="font-semibold">Information from players</p>
        <ul>
          <li>Attendance answers given through a personal attendance link, the signed-in &quot;My Games&quot; page, or a Telegram poll.</li>
          <li>Group join requests: the first and last name you enter, your account email and the date. The group&apos;s organizers see this information so they can approve or reject the request.</li>
        </ul>
        <p className="font-semibold">Telegram information (only for groups that connect Telegram)</p>
        <ul>
          <li>The Telegram group&apos;s chat id and title.</li>
          <li>For people who vote in the group&apos;s attendance or Player of the Match polls: their Telegram user id, username and first and last name as Telegram provides them, and their vote.</li>
          <li>The link between a Telegram user and a player in the group, when the player or organizer connects them.</li>
          <li>Records of the messages the service posted to the group (for example polls and published teams), so nothing is posted twice.</li>
        </ul>
        <p className="font-semibold">Security and technical information</p>
        <ul>
          <li>To protect sign-in and password reset against abuse, we keep keyed one-way digests (HMAC-SHA256) of the email address and the client network address of sign-in and password-reset attempts — not the email or address itself.</li>
          <li>Short-lived, single-use tokens for email verification, password reset, invitations and links (stored only as hashes).</li>
          <li>Our hosting provider processes standard technical request data, such as IP addresses and request logs, to operate and secure the service.</li>
        </ul>
      </LegalSection>

      <LegalSection id="google" title="3. Google Sign-In">
        <p>If you choose &quot;Continue with Google&quot;, Google asks you to share your basic profile with Team Balance Pro. We request only the standard sign-in permissions: <code>openid</code>, <code>email</code> and <code>profile</code>. We do not request access to your Gmail, contacts, calendar, Drive or any other Google data.</p>
        <ul>
          <li>
            <strong>What we receive:</strong> your Google account identifier, your email address and whether Google has verified it, and your name. Google may also include a profile picture link; we do not store or use it.
          </li>
          <li>
            <strong>How we use it:</strong> only to sign you in — to create your Team Balance Pro account (with your verified email and your name) or to recognize the account it is already linked to. We store the Google account identifier, the email address at the time of linking, and when the link was created and last used. We never store Google passwords or Google access tokens for later use.
          </li>
          <li>
            <strong>No automatic merging:</strong> a Google account is never connected to an existing password account just because the email matches; you connect it yourself from your account settings after confirming your password. You can disconnect Google there too.
          </li>
          <li>
            <strong>Sharing:</strong> we do not sell Google user data, use it for advertising, or share it with anyone except the service providers that run the app (section 8). Our use of information received from Google follows the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" className="underline" rel="noopener noreferrer">
              Google API Services User Data Policy
            </a>
            , including its Limited Use requirements.
          </li>
          <li>
            <strong>Deletion:</strong> see section 11.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="use" title="4. How we use information">
        <ul>
          <li>To provide the service: accounts and sign-in, groups and rosters, attendance, balanced team generation, publishing teams, results and recaps.</li>
          <li>To send the emails described in section 7.</li>
          <li>To post to a connected Telegram group when an organizer asks (for example an attendance poll or the published teams), and to read the answers to those polls.</li>
          <li>To keep the service secure (sign-in limits, abuse prevention) and to enforce plan limits.</li>
          <li>We do not sell personal information and do not use it for advertising.</li>
        </ul>
      </LegalSection>

      <LegalSection id="visibility" title="5. What other people can see">
        <ul>
          <li>Organizers (owners and admins) of a group see its players, attendance, join requests (including the requester&apos;s account email) and the information described above.</li>
          <li>
            Each group has a visibility setting chosen by its organizer. With <em>Public</em> or <em>Link</em> visibility, published teams, results, Player of the Match and recaps — including player names — can be seen by anyone who has the group&apos;s or match&apos;s link (Public pages are also reachable without a link). These pages are marked so search engines do not index them. <em>Private</em> groups are visible only to their organizers and linked players.
          </li>
          <li>Players who are linked to an account see their own attendance, their group&apos;s upcoming matches and published teams. Players never see skill ratings or stamina.</li>
          <li>A personal attendance link shows only that player&apos;s own name and answer. In a Telegram group, poll votes are visible to the group as Telegram shows them.</li>
        </ul>
      </LegalSection>

      <LegalSection id="ai" title="6. Match recaps written with AI">
        <p>
          If an organizer asks for an AI-written match recap, we send OpenAI only the facts needed to write it: sport, date, venue name, team names, scores, the Player of the Match names and the number of participants — no email addresses, ratings, stamina or Telegram identities. The request asks OpenAI not to store it. The organizer reviews the text before anything is published.
        </p>
      </LegalSection>

      <LegalSection id="email" title="7. Emails we send">
        <ul>
          <li>Account emails: email verification, password reset and organization invitations.</li>
          <li>Organizer notifications, for example when attendance for a scheduled match is ready.</li>
          <li>If enabled, reminders about the end of an organization&apos;s {TRIAL_DAYS}-day Pro trial to its owners.</li>
        </ul>
        <p>We do not send marketing emails. Emails are delivered by our email provider (section 8).</p>
      </LegalSection>

      <LegalSection id="providers" title="8. Service providers and sharing">
        <p>We share information only with providers that run parts of the service for us, and only what each needs:</p>
        <ul>
          <li><strong>Vercel</strong> — hosting and delivery of the website and application.</li>
          <li><strong>Neon</strong> — database hosting (Amazon Web Services, United States).</li>
          <li><strong>Resend</strong> — sending the emails in section 7.</li>
          <li><strong>Google</strong> — Google Sign-In, when you choose it.</li>
          <li><strong>Telegram</strong> — posting to and reading polls in Telegram groups that organizers connect.</li>
          <li><strong>OpenAI</strong> — AI-written match recaps, when an organizer requests one (section 6).</li>
          <li><strong>WeatherAPI.com</strong> — the weather forecast for a match, using the venue&apos;s map coordinates.</li>
          <li><strong>Geoapify</strong> — finding a venue&apos;s map location from the address an organizer types.</li>
          <li><strong>Stripe</strong> — payment processing for paid plans, once paid billing is available (it is not active today). Card details would be entered on Stripe&apos;s pages and never reach our servers.</li>
        </ul>
        <p>We may also disclose information if required by law. Links to maps open Google Maps or OpenStreetMap only when you choose to follow them.</p>
      </LegalSection>

      <LegalSection id="cookies" title="9. Cookies and browser storage">
        <ul>
          <li>Sign-in cookies set by our authentication system: a session cookie (keeps you signed in until you sign out; it expires after 30 days without use), a security (CSRF) cookie, and short-lived cookies used during Google Sign-In.</li>
          <li>A short-lived cookie (10 minutes) when you connect Google to your account.</li>
          <li>When you open a group invite link, your browser keeps the invitation for up to one hour so you can sign in and come back to it.</li>
        </ul>
        <p>We do not use analytics, advertising or tracking cookies, and we do not load third-party trackers.</p>
      </LegalSection>

      <LegalSection id="security" title="10. Security">
        <p>
          Connections use HTTPS. Passwords are stored only as bcrypt hashes; sign-in, invitation, claim and attendance links use random tokens of which only a hash is stored; access to every organization and group is checked on each request; and sign-in and password reset are rate-limited. No system is perfectly secure, but we work to protect your information.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="11. Retention and deletion">
        <ul>
          <li>Security digests of sign-in attempts are deleted after 1 day (successful sign-ins after 30 days); password-reset request records after 1 day.</li>
          <li>Single-use tokens expire: email verification after 24 hours, password reset after 1 hour, organization invitations and player claim links after 7 days, group invite links after the period the organizer chose (30 days by default), and personal attendance links when attendance for the match closes.</li>
          <li>Organizers can edit or delete players they manage. Players can disconnect Telegram from their profile.</li>
          <li>
            Other account, organization and group information is kept while the account or organization exists. <OwnerTodo id="retention" />
          </li>
          <li>
            To ask us to delete your account or data (including data received through Google Sign-In), contact us (section 12). <OwnerTodo id="deletion" />
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="rights" title="12. Your choices and how to contact us">
        <p>
          From your account settings you can change your password and connect or disconnect Google. Changing your name or email address is not self-service today. To access, correct, export or delete your information, or for any privacy question, contact us at <Contact />. If information about you was entered by an organizer, you can also ask that organizer. Depending on where you live, you may have additional rights under local law.
        </p>
      </LegalSection>

      <LegalSection id="children" title="13. Children">
        <p>
          <OwnerTodo id="age" />
        </p>
      </LegalSection>

      <LegalSection id="transfers" title="14. Where information is processed">
        <p>
          Our database is hosted in the United States (Amazon Web Services, US East). The website is served by Vercel, and our other providers (section 8) may process information in the United States or other countries. <OwnerTodo id="operator">Confirm the Vercel function region and any cross-border transfer wording you require</OwnerTodo>
        </p>
      </LegalSection>

      <LegalSection id="changes" title="15. Changes to this policy">
        <p>
          We will update this page when our practices change and change the effective date above. See also our{" "}
          <Link href={LEGAL_PATHS.terms} className="underline">
            Terms of Service
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}

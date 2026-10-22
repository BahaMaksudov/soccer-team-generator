import Link from "next/link";
import LegalPage, { ContactEmail, EffectiveDate, LegalSection } from "@/components/legal/LegalPage";
import { ACCOUNT_MIN_AGE, HOSTING, LEGAL_PATHS, OPERATING_BRAND, PRODUCT_NAME, legalCanonical, legalIsDraft } from "@/lib/legal";
import { TRIAL_DAYS } from "@/lib/entitlements";

/**
 * Public Privacy Policy. Every statement describes what the application does
 * today (verified in code and Production configuration); pending owner / attorney
 * items are OwnerTodo markers (src/lib/legal.ts). Noindex while a draft.
 */
export const metadata = {
  title: `Privacy Policy — ${PRODUCT_NAME}`,
  description: `How ${PRODUCT_NAME} collects, uses and protects information about organizers and players.`,
  alternates: { canonical: legalCanonical(LEGAL_PATHS.privacy) },
  ...(legalIsDraft() ? { robots: { index: false, follow: true } } : {}),
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <>
          <p>
            {PRODUCT_NAME} (&quot;we&quot;, &quot;us&quot;) is a web app that helps organizers of pickup and recreational sports groups manage players, attendance and balanced teams. {PRODUCT_NAME} is operated by an individual under the {OPERATING_BRAND} brand; {OPERATING_BRAND} is a brand name, not a registered company. This policy explains what information the service handles, why, who can see it, and the choices you have.
          </p>
          <p className="mt-2">
            Effective date: <EffectiveDate />
          </p>
          <p className="mt-2">
            Contact: <ContactEmail />
          </p>
        </>
      }
    >
      <LegalSection id="who" title="1. Account holders, organizers and players">
        <ul>
          <li>
            <strong>Account holders</strong> sign in to {PRODUCT_NAME}. Accounts are only for adults aged {ACCOUNT_MIN_AGE} or older (see section 13).
          </li>
          <li>
            <strong>Organizers</strong> are account holders who create an organization and groups and manage their players.
          </li>
          <li>
            <strong>Players</strong> take part in a group. A player may have a {PRODUCT_NAME} account linked to their player profile, or no account at all — in that case the player profile exists only because an organizer created it. Player profiles can belong to minors when the organizer has appropriate authority (section 13).
          </li>
        </ul>
        <p>
          Much of the player information in the service (for example names, ratings and attendance) is entered and managed by the group&apos;s organizer, who decides what to record and who can see the group. If you are a player and want information about you corrected or removed, you can ask your organizer or contact us (section 12).
        </p>
      </LegalSection>

      <LegalSection id="collect" title="2. Information we collect">
        <p className="font-semibold">Account information</p>
        <ul>
          <li>Your name and email address.</li>
          <li>If you sign up with email and password: your password, stored only as a one-way bcrypt hash. We never store your password itself.</li>
          <li>Whether and when your email address was verified.</li>
          <li>If you use Google Sign-In: see section 3.</li>
          <li>Your organizations, groups and role (owner, admin or member), invitations you send or accept, and group join requests you make.</li>
        </ul>
        <p className="font-semibold">Information organizers enter about players</p>
        <ul>
          <li>First and last name, playing position, a skill rating, a stamina value and whether the player is active, plus the communities (rosters) the player belongs to.</li>
          <li>Attendance for matches (playing, maybe, not playing), whether the answer came from the player or was set by the organizer, and when.</li>
          <li>Matches (date, time, venue, attendance deadline), generated and published teams, results, Player of the Match and match recaps.</li>
          <li>Venue names and addresses, and a map location for a venue when the organizer confirms one.</li>
        </ul>
        <p className="font-semibold">Information from players</p>
        <ul>
          <li>Attendance answers given through a personal attendance link, the signed-in &quot;My Games&quot; page, or a Telegram poll.</li>
          <li>Group join requests: the first and last name you enter, your account email and the date.</li>
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
          <li>Short-lived, single-use tokens for email verification, password reset, invitations and links, stored only as hashes.</li>
          <li>Our hosting provider processes standard technical request data, such as IP addresses and request logs, to operate and secure the service.</li>
        </ul>
      </LegalSection>

      <LegalSection id="google" title="3. Google Sign-In">
        <p>
          If you choose &quot;Continue with Google&quot;, Google asks you to share your basic profile with {PRODUCT_NAME}. We request only the standard sign-in permissions: <code>openid</code>, <code>email</code> and <code>profile</code>. We do not request access to your Gmail, contacts, calendar, Drive or any other Google data.
        </p>
        <ul>
          <li>
            <strong>What Google provides:</strong> your Google account identifier, your email address and whether Google has verified it, your name, and possibly a profile picture link.
          </li>
          <li>
            <strong>What we keep:</strong> your Google account identifier, the email address at the time your Google account was linked, and when the link was created and last used. A new account created with Google uses your verified Google email and your name. We do not store your profile picture, and we do not store Google access or refresh tokens.
          </li>
          <li>
            <strong>How we use it:</strong> only to sign you in — to create your account or to recognize the account your Google account is linked to.
          </li>
          <li>
            <strong>No automatic merging:</strong> a Google account is never connected to an existing password account just because the email address matches; you connect it yourself from your account settings after confirming your password. You can disconnect Google there too.
          </li>
          <li>
            <strong>Sharing:</strong> we do not sell Google user data, use it for advertising, or share it except with the service providers that run the app (section 8). Our use of information received from Google follows the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" className="underline" rel="noopener noreferrer">
              Google API Services User Data Policy
            </a>
            , including its Limited Use requirements.
          </li>
          <li>
            <strong>Deletion:</strong> you can ask us to delete your account and the Google information we keep (section 11).
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="use" title="4. How we use information">
        <ul>
          <li>To provide the service: accounts and sign-in, groups and rosters, attendance, balanced team generation, publishing teams, results and recaps.</li>
          <li>To send the emails described in section 7.</li>
          <li>To post to a connected Telegram group when an organizer asks (for example an attendance poll or the published teams), and to read the answers to those polls.</li>
          <li>To keep the service secure (sign-in limits, abuse prevention) and to apply plan limits.</li>
          <li>We do not sell personal information and do not use it for advertising.</li>
        </ul>
      </LegalSection>

      <LegalSection id="visibility" title="5. Who can see player information">
        <ul>
          <li>
            <strong>Organizers</strong> (owners and admins) of a group see its players — including skill ratings and stamina — attendance, join requests (including the requester&apos;s account email) and match information. Organization members with the &quot;member&quot; role can view the roster without skill ratings or stamina.
          </li>
          <li>
            <strong>Players</strong> never see skill ratings or stamina. A player with a linked account sees their own attendance and their group&apos;s upcoming matches and published teams. A personal attendance link shows only that player&apos;s own name and answer, plus the match details.
          </li>
          <li>
            <strong>Group visibility</strong> is chosen by the organizer:
            <ul className="mt-1">
              <li>
                <em>Public</em> — the group&apos;s page can be opened by anyone with its address and shows the roster (first and last names, positions and whether each player is active), published teams, results, Player of the Match and published recaps.
              </li>
              <li>
                <em>Link</em> — anyone the organizer gives the group&apos;s share link to can see recent published teams (names and positions); anyone with a match link can see that match&apos;s details, published teams, result, Player of the Match and recap.
              </li>
              <li>
                <em>Private</em> — none of this is shown through links; only organizers and players linked to the group can see it.
              </li>
            </ul>
            These pages ask search engines not to index them, but anyone who has a link can open it and pass it on. Other players&apos; attendance is not shown on these pages.
          </li>
          <li>
            <strong>Telegram:</strong> in a connected Telegram group, attendance and Player of the Match polls are not anonymous — members of the Telegram group can see who voted and how — and the published teams posted there include player names.
          </li>
          <li>
            <strong>AI recaps:</strong> a published recap can mention team names, scores and Player of the Match names, and is visible wherever the match&apos;s published information is visible.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="ai" title="6. Match recaps written with AI">
        <p>
          If an organizer asks for an AI-written match recap, we send OpenAI only the facts needed to write it: sport, date, venue name, team names, scores, the Player of the Match names and the number of participants — no email addresses, ratings, stamina or Telegram identities. The request asks OpenAI not to store it. The organizer reviews and edits the text before anything is published.
        </p>
      </LegalSection>

      <LegalSection id="email" title="7. Emails we send">
        <ul>
          <li>Account emails: email verification, password reset and organization invitations.</li>
          <li>Organizer notifications, for example when attendance for a scheduled match is ready.</li>
          <li>When enabled, reminders to organization owners about the end of the {TRIAL_DAYS}-day Pro trial.</li>
        </ul>
        <p>We do not send marketing emails. Emails are delivered by our email provider (section 8).</p>
      </LegalSection>

      <LegalSection id="providers" title="8. Service providers and sharing">
        <p>We share information only with providers that run parts of the service for us, and only what each needs:</p>
        <ul>
          <li><strong>Vercel</strong> — hosting and delivery of the website and application.</li>
          <li><strong>Neon</strong> — database hosting (Amazon Web Services, US East).</li>
          <li><strong>Resend</strong> — sending the emails in section 7.</li>
          <li><strong>Google</strong> — Google Sign-In, when you choose it.</li>
          <li><strong>Telegram</strong> — posting to and reading polls in Telegram groups that organizers connect.</li>
          <li><strong>OpenAI</strong> — AI-written match recaps, when an organizer requests one (section 6).</li>
          <li><strong>WeatherAPI.com</strong> — the weather forecast for a match, using the venue&apos;s map coordinates.</li>
          <li><strong>Geoapify</strong> — finding a venue&apos;s map location from the address an organizer types.</li>
          <li><strong>Stripe</strong> — planned payment processor for paid subscriptions. Paid billing is not active, and no payment information is collected today.</li>
        </ul>
        <p>We may disclose information when required by law. Map links open Google Maps or OpenStreetMap only when you choose to follow them.</p>
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
          Connections use HTTPS. Passwords are stored only as bcrypt hashes; sign-in, invitation, claim and attendance links use random tokens of which only a hash is stored; access to every organization and group is checked on each request; and sign-in and password reset are rate-limited. No system is perfectly secure, and we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="11. Retention and deletion">
        <p className="font-semibold">Retention</p>
        <ul>
          <li>We keep information for as long as it is needed to operate the service.</li>
          <li>Some records expire automatically: security digests of sign-in attempts after 1 day (successful sign-ins after 30 days) and password-reset request records after 1 day.</li>
          <li>Single-use tokens expire: email verification after 24 hours, password reset after 1 hour, organization invitations and player claim links after 7 days, group invite links after the period the organizer chose (30 days by default), and personal attendance links when attendance for the match closes.</li>
          <li>Other account, organization, roster, match and attendance information is not deleted automatically; it remains until it is deleted by an organizer or by us on request.</li>
          <li>We may keep certain information where it is reasonably needed for security, legal or operational purposes, such as resolving disputes or preventing abuse.</li>
        </ul>
        <p className="font-semibold">Deletion and correction</p>
        <ul>
          <li>Organizers can edit or delete the player profiles they manage. Players can disconnect Telegram from their linked profile.</li>
          <li>
            There is no self-service account deletion. To ask for your account or information to be deleted or corrected — including information we received through Google Sign-In — email <ContactEmail />. Requests are handled manually.
          </li>
          <li>We may need to verify your identity, and your authority to act for someone else, before acting on a request.</li>
          <li>Player information in a group is managed by that group&apos;s organizer; a request about it may require coordination with the organizer, and organizers and players may have different rights over it.</li>
          <li>Some information may be retained where required by law or otherwise justified (see above). Deleted information may remain in backups or logs for a period before it is overwritten.</li>
        </ul>
      </LegalSection>

      <LegalSection id="rights" title="12. Your choices and how to contact us">
        <p>
          From your account settings you can change your password and connect or disconnect Google. Changing your name or email address is not self-service today. To access, correct, export or delete your information, or for any privacy question, email <ContactEmail />. If information about you was entered by an organizer, you can also ask that organizer. Depending on where you live, you may have additional rights under applicable law.
        </p>
      </LegalSection>

      <LegalSection id="children" title="13. Adults-only accounts and youth player profiles">
        <ul>
          <li>
            {PRODUCT_NAME} accounts are only for adults aged {ACCOUNT_MIN_AGE} or older. The service does not verify ages.
          </li>
          <li>
            Organizers may create and manage player profiles for minors — for example on youth teams — only when they have appropriate authority, such as permission from a parent or guardian. Minors should not create accounts or use the service directly; the service does not verify parental consent.
          </li>
          <li>
            Youth player profiles are handled exactly like other player profiles — there are no separate youth protections. In particular: in a <em>Public</em> group, anyone with the group&apos;s address can see the roster with each youth player&apos;s first and last name and position; in a <em>Link</em> group, anyone holding a group share link or match link can see their names in published teams, results, Player of the Match and recaps; and in a connected Telegram group, members can see names in posted teams and who voted how in the non-anonymous polls (section 5). Organizers decide these settings; organizers of youth groups should consider <em>Private</em> visibility and not connecting a Telegram group.
          </li>
          <li>
            If you believe a minor created an account, or that information about a minor was entered without appropriate authority, contact us at <ContactEmail /> and we will review it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="transfers" title="14. Where information is processed">
        <p>
          {PRODUCT_NAME} runs in the United States: the application runs on Vercel in its {HOSTING.appRegion.replace("Vercel region ", "")} region, and our database is hosted by {HOSTING.databaseRegion}. Vercel may deliver pages to you through its global network. Our other service providers (section 8) may process information in the United States or other countries. If you use the service from outside the United States, your information is processed in the United States.
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

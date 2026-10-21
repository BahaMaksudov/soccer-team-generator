import Link from "next/link";
import LegalPage, { LegalSection, OwnerTodo } from "@/components/legal/LegalPage";
import { LEGAL_PATHS, legalCanonical, legalIsDraft } from "@/lib/legal";
import { supportEmail } from "@/lib/support";
import { PLAN_LIMITS, TRIAL_DAYS } from "@/lib/entitlements";
import { PRO_PRICES_USD } from "@/lib/billing/config";

/**
 * Public Terms of Service. Plans, trial and billing statements come from the
 * enforced plan catalog and billing configuration; open business / legal facts
 * are OwnerTodo markers (src/lib/legal.ts). Noindex while a draft.
 */
export const metadata = {
  title: "Terms of Service — Team Balance Pro",
  description: "The terms for using Team Balance Pro as an organizer or player.",
  alternates: { canonical: legalCanonical(LEGAL_PATHS.terms) },
  ...(legalIsDraft() ? { robots: { index: false, follow: true } } : {}),
};

const plural = (n: number | null, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function TermsPage() {
  const email = supportEmail();
  const free = PLAN_LIMITS.FREE;
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <>
          <p>
            These terms govern your use of Team Balance Pro at teambalancepro.com (the &quot;service&quot;), operated by <OwnerTodo id="operator">operator&apos;s legal name</OwnerTodo>. By creating an account or using the service you agree to them. Please also read our{" "}
            <Link href={LEGAL_PATHS.privacy} className="underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="mt-2">
            Effective date: <OwnerTodo id="effective-date">date</OwnerTodo>
          </p>
        </>
      }
    >
      <LegalSection id="service" title="1. The service">
        <p>
          Team Balance Pro helps organizers of pickup and recreational sports groups keep a roster, collect attendance for matches, generate balanced teams and share teams, results and recaps with their players — on the website and, optionally, in a connected Telegram group. Features may change over time.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="2. Accounts">
        <ul>
          <li>You can create an account with an email address and password (the email must be verified) or with Google Sign-In.</li>
          <li>You are responsible for keeping your sign-in details secure and for activity under your account. Tell us if you believe your account has been compromised.</li>
          <li>Provide accurate information and do not create accounts for other people without their permission.</li>
          <li>
            Eligibility: <OwnerTodo id="age" />
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="roles" title="3. Organizers and players">
        <ul>
          <li>
            <strong>Organizers</strong> (organization owners and admins) manage groups, players, matches, attendance and published teams. Organizers are responsible for the information they enter about players, including having an appropriate basis to record it, keeping it accurate, and deciding who can see their group (group visibility settings).
          </li>
          <li>
            <strong>Players</strong> may take part without an account (for example through a personal attendance link or a Telegram poll) or with an account linked to their player profile. Joining a group or linking a profile never gives a player organizer access.
          </li>
          <li>Skill ratings and stamina values entered by organizers are used only to balance teams and are not shown to players.</li>
        </ul>
      </LegalSection>

      <LegalSection id="invitations" title="4. Invitations, links and rosters">
        <ul>
          <li>Organizers can share group invite links, player claim links, personal attendance links and match links. Anyone holding such a link can use it for its purpose, so organizers should share links only with the intended people and replace or turn off a link that was shared too widely.</li>
          <li>A group invite link only lets a signed-in person with a verified email ask to join; an organizer approves or rejects every request and decides which player profile, if any, the person is linked to.</li>
          <li>A personal attendance link lets exactly one player answer for exactly one match.</li>
        </ul>
      </LegalSection>

      <LegalSection id="acceptable-use" title="5. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use the service for anything unlawful, or to harass, impersonate or harm others;</li>
          <li>enter information about people that you are not entitled to record, or answer attendance on behalf of someone else without their permission;</li>
          <li>send spam or unwanted messages through the service or its Telegram integration;</li>
          <li>try to access other organizations&apos; data, probe or disrupt the service, bypass its limits or security, or scrape it;</li>
          <li>resell or provide the service to others as your own without our permission.</li>
        </ul>
      </LegalSection>

      <LegalSection id="attendance" title="6. Attendance, scheduling and teams">
        <p>
          Attendance, deadlines, schedules, reminders, weather and generated teams are tools to help organizers; they depend on information entered by people and on third-party services. We do not guarantee that every answer, message, forecast or team is complete, delivered on time or suitable, and organizers remain responsible for running their games — including venues, safety and who plays. Weather forecasts come from a third-party provider and may be inaccurate. AI-written recaps are drafts that the organizer reviews before publishing.
        </p>
      </LegalSection>

      <LegalSection id="telegram" title="7. Telegram and other third-party services">
        <p>
          Organizers can connect a Telegram group. The service then posts what organizers ask it to post (such as attendance polls and published teams) and reads the answers to its polls. Telegram, Google and other third-party services are governed by their own terms and privacy policies, and we are not responsible for them or for their availability. Organizers should only connect Telegram groups they administer.
        </p>
      </LegalSection>

      <LegalSection id="plans" title="8. Plans, trial and billing">
        <ul>
          <li>
            <strong>Free plan:</strong> available at no charge with limits (currently {plural(free.activeGroups, "active group", "active groups")}, {plural(free.activePlayers, "active player", "active players")}, {plural(free.monthlyMatches, "new match", "new matches")} per month, {plural(free.activeSchedules, "active recurring schedule", "active recurring schedules")} and {plural(free.monthlyAiRecaps, "AI recap", "AI recaps")} per month{free.telegram ? "" : "; no Telegram integration"}). Reaching a limit never deletes your data.
          </li>
          <li>
            <strong>Pro trial:</strong> the first organization you create includes a {TRIAL_DAYS}-day Pro trial — one trial per account, no payment card required. When it ends, nothing is charged and the organization moves to the Free plan.
          </li>
          <li>
            <strong>Pro plan:</strong> listed at {PRO_PRICES_USD.month} per month or {PRO_PRICES_USD.year} per year per organization (USD). Paid subscriptions are not available yet; when they are, payments will be processed by Stripe, subscriptions renew automatically until canceled, can be canceled at any time, and stay active until the end of the paid period. <OwnerTodo id="billing" />
          </li>
          <li>We may change plans, limits or prices.</li>
        </ul>
      </LegalSection>

      <LegalSection id="content" title="9. Your content and our service">
        <ul>
          <li>You keep your rights in the information you and your group enter. You allow us to store, process and display it as needed to provide the service to you and the people you share it with.</li>
          <li>The service itself — its software, design, name and logo — belongs to us. You may not copy or reuse it except as these terms allow.</li>
        </ul>
      </LegalSection>

      <LegalSection id="termination" title="10. Suspension and termination">
        <p>
          You may stop using the service at any time. To have your account or data deleted, contact us (section 13). We may suspend or end access for anyone who breaks these terms or puts the service or other users at risk, and we may change or discontinue features. <OwnerTodo id="deletion" />
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="11. Disclaimers and limitation of liability">
        <p>
          The service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind to the extent permitted by law. To the extent permitted by law, we are not liable for indirect, incidental or consequential damages, or for losses arising from games, injuries, missed messages, inaccurate attendance, forecasts or teams. <OwnerTodo id="liability" />
        </p>
      </LegalSection>

      <LegalSection id="law" title="12. Governing law and changes">
        <p>
          Governing law and venue: <OwnerTodo id="governing-law" />
        </p>
        <p>We may update these terms. We will post the new version here with a new effective date; continuing to use the service after that means you accept the updated terms.</p>
      </LegalSection>

      <LegalSection id="contact" title="13. Contact">
        <p>
          Questions about these terms:{" "}
          {email ? (
            <a href={`mailto:${email}`} className="font-semibold underline">
              {email}
            </a>
          ) : (
            <OwnerTodo id="contact" />
          )}
        </p>
      </LegalSection>
    </LegalPage>
  );
}

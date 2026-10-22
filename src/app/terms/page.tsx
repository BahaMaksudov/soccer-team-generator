import Link from "next/link";
import LegalPage, { ContactEmail, EffectiveDate, LegalSection, OwnerTodo } from "@/components/legal/LegalPage";
import { ACCOUNT_MIN_AGE, GOVERNING_LAW, LEGAL_PATHS, OPERATING_BRAND, PRODUCT_NAME, legalCanonical, legalIsDraft } from "@/lib/legal";
import { PLAN_LIMITS, TRIAL_DAYS } from "@/lib/entitlements";
import { PRO_PRICES_USD } from "@/lib/billing/config";

/**
 * Public Terms of Service. Plans and trial come from the enforced plan catalog;
 * paid billing is described as NOT active. Pending owner / attorney items are
 * OwnerTodo markers (src/lib/legal.ts). Noindex while a draft.
 */
export const metadata = {
  title: `Terms of Service — ${PRODUCT_NAME}`,
  description: `The terms for using ${PRODUCT_NAME} as an organizer or player.`,
  alternates: { canonical: legalCanonical(LEGAL_PATHS.terms) },
  ...(legalIsDraft() ? { robots: { index: false, follow: true } } : {}),
};

const plural = (n: number | null, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function TermsPage() {
  const free = PLAN_LIMITS.FREE;
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <>
          <p>
            These terms govern your use of {PRODUCT_NAME} at teambalancepro.com (the &quot;service&quot;). {PRODUCT_NAME} is operated under the {OPERATING_BRAND} brand by an individual (&quot;we&quot;, &quot;us&quot;). <OwnerTodo id="operator-identity" /> By creating an account or using the service you agree to these terms. Please also read our{" "}
            <Link href={LEGAL_PATHS.privacy} className="underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="mt-2">
            Effective date: <EffectiveDate />
          </p>
        </>
      }
    >
      <LegalSection id="service" title="1. The service">
        <p>
          {PRODUCT_NAME} helps organizers of pickup and recreational sports groups keep a roster, collect attendance for matches, generate balanced teams and share teams, results and recaps with their players — on the website and, optionally, in a connected Telegram group. We may add, change or remove features over time.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="2. Accounts and eligibility">
        <ul>
          <li>You must be at least {ACCOUNT_MIN_AGE} years old to create or use an account. By creating an account you confirm that you are.</li>
          <li>You can sign up with an email address and password (the email must be verified) or with Google Sign-In.</li>
          <li>Keep your sign-in details secure; you are responsible for activity under your account. Tell us promptly if you believe your account has been compromised.</li>
          <li>Provide accurate information, and do not create accounts for other people.</li>
        </ul>
      </LegalSection>

      <LegalSection id="roles" title="3. Organizers and players">
        <ul>
          <li>
            <strong>Organizers</strong> (organization owners and admins) manage groups, players, matches, attendance and published teams. Organizers are responsible for the information they enter about players: having appropriate authority or permission to record it, keeping it accurate, and choosing who can see their group through its visibility setting, shared links and any connected Telegram group.
          </li>
          <li>
            <strong>Youth players:</strong> organizers may keep player profiles for minors only with appropriate authority, such as permission from a parent or guardian. Minors may not hold accounts. We do not verify ages or parental permission; organizers are responsible for obtaining any permission required, including for showing youth players&apos; names through Public or link-shared group pages and connected Telegram groups.
          </li>
          <li>
            <strong>Players</strong> may take part without an account (for example through a personal attendance link or a Telegram poll) or with an adult account linked to their player profile. Joining a group or linking a profile never gives a player organizer access.
          </li>
          <li>Skill ratings and stamina values entered by organizers are used only to balance teams and are not shown to players.</li>
        </ul>
      </LegalSection>

      <LegalSection id="invitations" title="4. Invitations, links and rosters">
        <ul>
          <li>Organizers can share group invite links, player claim links, personal attendance links and match links. Anyone who holds such a link can use it for its purpose, so share links only with the intended people, and replace or turn off a link that was shared too widely.</li>
          <li>A group invite link only lets a signed-in person with a verified email ask to join. An organizer approves or rejects every request and decides which player profile, if any, the person is linked to.</li>
          <li>A personal attendance link lets exactly one player answer for exactly one match.</li>
        </ul>
      </LegalSection>

      <LegalSection id="acceptable-use" title="5. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use the service for anything unlawful, or to harass, impersonate or harm others;</li>
          <li>enter information about people that you are not entitled to record, or answer attendance for someone else without their permission;</li>
          <li>send spam or unwanted messages through the service or its Telegram integration;</li>
          <li>try to access other organizations&apos; data, probe or disrupt the service, get around its limits or security, or scrape it;</li>
          <li>resell the service or present it as your own without our permission.</li>
        </ul>
      </LegalSection>

      <LegalSection id="tools" title="6. Schedules, attendance, weather and AI content">
        <ul>
          <li>Attendance, deadlines, schedules, reminders and generated teams help organizers plan games. They depend on information people enter and on third-party services, so they may be incomplete, delayed or wrong. Please check important details yourself.</li>
          <li>Weather forecasts come from a third-party provider and may be inaccurate. Do not rely on them for safety decisions.</li>
          <li>AI-written match recaps are drafts that the organizer reviews and edits before publishing. They may contain mistakes; organizers are responsible for what they publish.</li>
          <li>Organizers remain responsible for running their games, including venues, safety and who plays.</li>
        </ul>
      </LegalSection>

      <LegalSection id="third-parties" title="7. Telegram and other third-party services">
        <p>
          Organizers can connect a Telegram group they administer. The service then posts what organizers ask it to post (such as attendance polls and published teams) and reads the answers to its polls. Telegram, Google and other third-party services are governed by their own terms and privacy policies. We are not responsible for those services or their availability.
        </p>
      </LegalSection>

      <LegalSection id="plans" title="8. Plans, trial and billing">
        <ul>
          <li>
            <strong>Free plan:</strong> available at no charge, with limits (currently {plural(free.activeGroups, "active group", "active groups")}, {plural(free.activePlayers, "active player", "active players")}, {plural(free.monthlyMatches, "new match", "new matches")} per month, {plural(free.activeSchedules, "active recurring schedule", "active recurring schedules")} and {plural(free.monthlyAiRecaps, "AI recap", "AI recaps")} per month{free.telegram ? "" : "; no Telegram integration"}). Reaching a limit does not delete your data.
          </li>
          <li>
            <strong>Pro trial:</strong> the first organization you create includes a {TRIAL_DAYS}-day Pro trial — one trial per account, no payment details required. When it ends, nothing is charged and the organization moves to the Free plan.
          </li>
          <li>
            <strong>Paid plans:</strong> paid Pro subscriptions are planned but <strong>not available yet</strong>, and no one is charged today. Our website may show planned prices (currently {PRO_PRICES_USD.month} per month or {PRO_PRICES_USD.year} per year per organization, in USD). Terms for paid subscriptions — including billing, renewal, cancellation and refunds — will be published before paid subscriptions are offered.
          </li>
          <li>We may change plans, limits or planned prices.</li>
        </ul>
      </LegalSection>

      <LegalSection id="content" title="9. Your content and our service">
        <ul>
          <li>You keep your rights in the information you and your group enter. You allow us to store, process and display it as needed to provide the service to you and to the people you share it with.</li>
          <li>The service itself — its software, design, name and logo — belongs to us or our licensors. You may not copy or reuse it except as these terms allow.</li>
        </ul>
      </LegalSection>

      <LegalSection id="termination" title="10. Suspension and termination">
        <p>
          You may stop using the service at any time. To have your account or information deleted, email <ContactEmail />; requests are handled manually as described in our Privacy Policy. We may suspend or end access for anyone who breaks these terms or puts the service or other people at risk, and we may change or discontinue the service or parts of it. Where reasonable, we will try to give notice.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="11. Availability and disclaimers">
        <p>
          We work to keep the service available and accurate, but it is provided &quot;as is&quot; and &quot;as available&quot;. To the extent permitted by law, we do not make warranties beyond those stated in these terms — for example, that the service will be uninterrupted or error-free, or that schedules, attendance, forecasts, generated teams or AI-written content will be accurate or complete.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="12. Limitation of liability">
        <p>
          To the extent permitted by law, we are not liable for indirect, incidental, special or consequential damages, or for losses arising from games or other activities organized using the service, from missed or delayed messages, or from inaccurate attendance, forecasts or teams. Nothing in these terms limits liability that cannot be limited by law, or any rights you have as a consumer under applicable law. <OwnerTodo id="attorney-liability" />
        </p>
      </LegalSection>

      <LegalSection id="law" title="13. Governing law">
        <p>These terms are governed by the laws of {GOVERNING_LAW}, without regard to its conflict-of-laws rules, except where the law of your place of residence gives you protections that cannot be waived.</p>
      </LegalSection>

      <LegalSection id="changes" title="14. Changes to these terms">
        <p>We may update these terms. We will post the new version here with a new effective date. If you keep using the service after the update takes effect, the updated terms apply.</p>
      </LegalSection>

      <LegalSection id="contact" title="15. Contact">
        <p>
          Questions about these terms: <ContactEmail />. <OwnerTodo id="mailing-address" />
        </p>
      </LegalSection>
    </LegalPage>
  );
}

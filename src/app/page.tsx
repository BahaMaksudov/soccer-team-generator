import Link from "next/link";
import Image from "next/image";
import {
  Activity,
  CalendarCheck,
  CalendarDays,
  Check,
  ClipboardCheck,
  Clock,
  Layers,
  MapPin,
  Scale,
  Send,
  Shield,
  Shuffle,
  Sparkles,
  Star,
  Target,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { BalanceBadge, Logo, MARKETING_NAV, SectionHead, TeamColumn, linkFocus } from "@/components/marketing/parts";
import { marketingSports } from "@/lib/marketing/sports";
import { cn } from "@/lib/cn";
import pickupGame from "../../public/marketing/pickup-game.jpg";

/**
 * UI-1 — Team Balance Pro marketing homepage (replaces the legacy root
 * redirect to the default public Group). Static, presentation-only server
 * component: no database, session, tenant or Telegram access. All team /
 * match content below is clearly labelled ILLUSTRATIVE example data.
 * Every product claim corresponds to existing production functionality.
 */

export const metadata = {
  title: "Team Balance Pro — Fair teams for pickup sports",
  description: "Create fair, balanced teams for pickup games, leagues, and recreational sports in seconds.",
  openGraph: {
    title: "Team Balance Pro — Fair teams for pickup sports",
    description: "Create fair, balanced teams for pickup games, leagues, and recreational sports in seconds.",
    type: "website",
  },
};

// Illustrative example players (not real users).
const TEAM_1 = ["Alex", "Ben", "Carla", "Dev", "Eli"];
const TEAM_2 = ["Femi", "Gabe", "Hana", "Ivan", "Jo"];

export default function MarketingHomePage() {
  return (
    <div
      className={cn(
        "min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased",
        // Display font + tight tracking for this page's headings only (no global restyle).
        "[&_h1]:font-display [&_h2]:font-display [&_h3]:font-display [&_h4]:font-display",
        "[&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em] [&_h3]:tracking-[-0.02em] [&_h4]:tracking-[-0.02em]"
      )}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-tbp-sm focus:bg-card focus:px-4 focus:py-2 focus:font-semibold focus:shadow-lift focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main">
        <Hero />
        <ValueStrip />
        <HowItWorks />
        <ProductFlow />
        <BalanceSection />
        <Sports />
        <Audiences />
        <Comms />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.1fr_1fr]">
      <div>
        <p className="eyebrow">For pickup games &amp; leagues</p>
        <h1 id="hero-title" className="mt-4 text-4xl font-black leading-[1.05] sm:text-5xl lg:text-6xl">
          <span className="block">Better teams.</span>
          <span className="block">Better games.</span>
          <span className="block text-primary">Less organizing.</span>
        </h1>
        <p className="mt-6 max-w-lg text-lg text-muted-foreground">
          Create fair, balanced teams for pickup games, leagues, and recreational sports in seconds.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="xl">
            <Link href="/signup">Create Your Group</Link>
          </Button>
          <Button asChild size="xl" variant="outline">
            <a href="#how">See How It Works</a>
          </Button>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">Soccer · Basketball · Volleyball · Football · and more</p>
      </div>

      <div className="relative">
        <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-secondary" aria-hidden="true" />
        <article className="rounded-tbp-2xl border border-border bg-card p-5 shadow-lift sm:p-6" aria-label="Example: balanced teams for a pickup game">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Example match</p>
              <h3 className="mt-1 text-xl font-extrabold">Sunday Pickup Soccer</h3>
              <p className="mt-0.5 text-xs font-semibold text-muted-foreground">Sun · 7:00 PM · Community Center</p>
            </div>
            <BalanceBadge />
          </div>
          <div className="mt-5 flex gap-3 sm:gap-4">
            <TeamColumn name="Team 1" players={TEAM_1} tone="a" />
            <TeamColumn name="Team 2" players={TEAM_2} tone="b" />
          </div>
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4 text-sm">
            <span className="text-muted-foreground">10 players playing</span>
            <span className="font-semibold text-primary">Teams published</span>
          </div>
        </article>
      </div>
    </section>
  );
}

const VALUES = [
  { icon: Scale, t: "Balanced automatically", d: "Competitive teams from player skill, positions, and who is playing." },
  { icon: CalendarCheck, t: "Built for game day", d: "Attendance, published teams and results for every match." },
  { icon: Layers, t: "Multiple sports", d: "Soccer, basketball, volleyball, American football, and more." },
  { icon: Clock, t: "Less organizer work", d: "Less time sorting players, more time playing." },
];

function ValueStrip() {
  return (
    <section aria-labelledby="values-title" className="border-y border-border bg-card">
      <h2 id="values-title" className="sr-only">
        Why Team Balance Pro
      </h2>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {VALUES.map(({ icon: I, t, d }) => (
          <div key={t} className="flex gap-3">
            <I className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <h3 className="font-bold">{t}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const STEPS = [
  { icon: Users, t: "Create your group", d: "Name your group and choose its sport." },
  { icon: UserPlus, t: "Add your players", d: "Build your roster with each player's skill, stamina and position." },
  { icon: ClipboardCheck, t: "Organize a match", d: "Set the date, time and place, and track who is playing." },
  { icon: Shuffle, t: "Generate balanced teams", d: "Review the suggested teams, then publish them when you're ready." },
];

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
      <SectionHead id="how-title" eyebrow="How it works" title="From player list to game day in minutes" />
      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(({ icon: I, t, d }, i) => (
          <li key={t} className="relative rounded-tbp-2xl border border-border bg-card p-6 shadow-card">
            <div className="flex items-center justify-between">
              <span className="font-display text-4xl font-black text-primary/20" aria-hidden="true">
                0{i + 1}
              </span>
              <I className="size-5 text-primary" aria-hidden="true" />
            </div>
            <h3 className="mt-6 text-lg font-bold">
              <span className="sr-only">Step {i + 1}: </span>
              {t}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">{d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FlowCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <article className="flex flex-col rounded-tbp-2xl border border-pitch-foreground/10 bg-card p-5 text-card-foreground shadow-card">
      <h3 className="eyebrow">{label}</h3>
      <div className="mt-4 flex-1">{children}</div>
    </article>
  );
}

function ProductFlow() {
  return (
    <section id="features" aria-labelledby="features-title" className="pitch-lines scroll-mt-16 bg-pitch text-pitch-foreground">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <p className="eyebrow !text-accent">The full game day</p>
        <h2 id="features-title" className="mt-3 max-w-2xl text-3xl font-extrabold sm:text-4xl">
          More than a team generator. A complete game-day organizer.
        </h2>
        <p className="mt-3 text-sm opacity-80">Example screens with illustrative data.</p>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FlowCard label="Match">
            <p className="font-display text-lg font-extrabold">Sunday Pickup Soccer</p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <CalendarDays className="size-4" aria-hidden="true" /> Sunday
              </li>
              <li className="flex items-center gap-2">
                <Clock className="size-4" aria-hidden="true" /> 7:00 PM
              </li>
              <li className="flex items-center gap-2">
                <MapPin className="size-4" aria-hidden="true" /> Community Center
              </li>
            </ul>
          </FlowCard>
          <FlowCard label="Attendance">
            <ul className="space-y-2 text-sm font-semibold">
              {(
                [
                  ["Playing", 10, "bg-primary"],
                  ["Maybe", 2, "bg-accent"],
                  ["Not playing", 3, "bg-muted-foreground/40"],
                ] as const
              ).map(([l, n, c]) => (
                <li key={l} className="flex items-center justify-between rounded-tbp-sm bg-muted px-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className={cn("size-2 rounded-full", c)} aria-hidden="true" />
                    {l}
                  </span>
                  <span className="font-display text-lg">{n}</span>
                </li>
              ))}
            </ul>
          </FlowCard>
          <FlowCard label="Balanced teams">
            <div className="flex items-center justify-between font-display text-lg font-extrabold">
              <span className="text-team-a">Team 1</span>
              <span className="text-sm text-muted-foreground">vs</span>
              <span className="text-team-b">Team 2</span>
            </div>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full" aria-hidden="true">
              <span className="w-1/2 bg-team-a" />
              <span className="w-1/2 bg-team-b" />
            </div>
            <div className="mt-4">
              <BalanceBadge />
            </div>
          </FlowCard>
          <FlowCard label="After the game">
            <p className="text-xs font-semibold text-muted-foreground">Final score</p>
            <p className="mt-1 font-display text-2xl font-black">
              Team 1 <span className="text-primary">5</span> — <span className="text-team-b">3</span> Team 2
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-tbp-sm bg-secondary px-3 py-2 text-sm">
              <Trophy className="size-4 text-accent" aria-hidden="true" />
              <span>
                <span className="block text-xs text-muted-foreground">Player of the Match</span>
                <strong>Carla</strong>
              </span>
            </div>
          </FlowCard>
        </div>
      </div>
    </section>
  );
}

const FACTORS = [
  { icon: Star, t: "Player skill" },
  { icon: Target, t: "Sport-specific positions & roles" },
  { icon: Activity, t: "Stamina" },
  { icon: Scale, t: "Overall team strength" },
  { icon: Shield, t: "Role coverage on both sides" },
];

function BalanceSection() {
  return (
    <section aria-labelledby="balance-title" className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
      <div>
        <SectionHead
          id="balance-title"
          eyebrow="Balance engine"
          title="Balanced, not just random."
          body="Shuffling names into two lists rarely makes a good game. Team Balance Pro weighs what actually matters."
        />
        <ul className="mt-8 space-y-3">
          {FACTORS.map(({ icon: I, t }) => (
            <li key={t} className="flex items-center gap-3 font-semibold">
              <span className="grid size-9 place-items-center rounded-tbp-sm bg-secondary text-primary" aria-hidden="true">
                <I className="size-4" />
              </span>
              {t}
            </li>
          ))}
        </ul>
      </div>
      <article className="rounded-tbp-2xl border border-border bg-card p-6 shadow-lift" aria-label="Example: balance overview for generated teams">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-bold">Why these teams?</h3>
          <BalanceBadge />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Example</p>
        <div className="mt-5">
          <div className="flex justify-between text-sm">
            <span className="font-semibold">Team strength</span>
            <span className="text-muted-foreground">Team 1 · Team 2</span>
          </div>
          <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            <span className="bg-team-a" style={{ width: "51%" }} />
            <span className="bg-team-b" style={{ width: "49%" }} />
          </div>
        </div>
        <ul className="mt-5 space-y-2 text-sm">
          {[
            ["Goalkeepers", "1 · 1"],
            ["Defenders", "2 · 2"],
          ].map(([role, split]) => (
            <li key={role} className="flex justify-between rounded-tbp-sm bg-muted px-3 py-2">
              <span className="font-semibold">{role}</span>
              <span className="text-muted-foreground">{split}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex gap-3 rounded-tbp-md bg-muted p-4 text-sm">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          <p>
            <strong>Suggestion:</strong> Swap Ben and Gabe to make the teams even closer.
          </p>
        </div>
      </article>
    </section>
  );
}

function Sports() {
  return (
    <section id="sports" aria-labelledby="sports-title" className="scroll-mt-16 border-y border-border bg-card">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionHead id="sports-title" eyebrow="Multi-sport" title="One organizer for every game you run" center />
        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {marketingSports().map((s) => (
            <li key={s.label} className="rounded-tbp-2xl border border-border bg-background p-5 text-center transition-shadow hover:shadow-card">
              <span className="text-4xl" aria-hidden="true">
                {s.emoji}
              </span>
              <h3 className="mt-3 font-bold">{s.label}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{s.roles}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CheckList({ items, onPrimary = false }: { items: string[]; onPrimary?: boolean }) {
  return (
    <ul className="mt-6 grid gap-3 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i} className="flex items-start gap-2 text-sm font-medium">
          <Check className={cn("mt-0.5 size-4 shrink-0", onPrimary ? "text-accent" : "text-primary")} aria-hidden="true" />
          {i}
        </li>
      ))}
    </ul>
  );
}

function Audiences() {
  return (
    <section aria-labelledby="audiences-title" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <SectionHead id="audiences-title" eyebrow="For everyone on the roster" title="Built for organizers. Easy for players." />
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        <article className="rounded-tbp-2xl bg-primary p-8 text-primary-foreground">
          <h3 className="text-2xl font-extrabold">For organizers</h3>
          <CheckList
            onPrimary
            items={["Manage players", "Track attendance", "Generate balanced teams", "Publish teams", "Record results", "Choose Player of the Match", "Share a match summary"]}
          />
        </article>
        <article className="rounded-tbp-2xl border border-border bg-card p-8 shadow-card">
          <h3 className="text-2xl font-extrabold">For players</h3>
          <CheckList items={["See upcoming matches", "Respond to attendance", "View published teams", "See results", "See Player of the Match", "See recent games"]} />
        </article>
      </div>
    </section>
  );
}

function Comms() {
  return (
    <section aria-labelledby="comms-title" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
      <div className="grid items-center gap-8 rounded-tbp-2xl border border-border bg-secondary p-8 md:grid-cols-[1fr_auto]">
        <div>
          <p className="eyebrow">Keep everyone in the loop</p>
          <h2 id="comms-title" className="mt-2 text-2xl font-extrabold">
            Match updates where your group already talks
          </h2>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Post attendance polls, published teams, and the match summary to your group&apos;s Telegram chat — when you choose to.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-card px-4 py-2 text-sm font-semibold shadow-card">
            <Send className="size-4 text-primary" aria-hidden="true" />
            Telegram
          </span>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative isolate overflow-hidden bg-pitch text-pitch-foreground">
      <Image src={pickupGame} alt="" placeholder="blur" sizes="100vw" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-35" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-pitch via-pitch/70 to-pitch/30" aria-hidden="true" />
      <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 md:py-32">
        <h2 id="cta-title" className="text-4xl font-black sm:text-5xl">
          Ready for a better game?
        </h2>
        <p className="mt-4 text-lg opacity-90">Spend less time dividing teams and more time playing.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="xl" variant="accent">
            <Link href="/signup">Create Your Group</Link>
          </Button>
          <Button asChild size="xl" variant="onPitch">
            <Link href="/login">Sign In</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-pitch text-pitch-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 border-t border-pitch-foreground/10 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <Logo onDark />
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {MARKETING_NAV.map((n) => (
            <a key={n.href} href={n.href} className={cn("opacity-85 hover:opacity-100", linkFocus)}>
              {n.label}
            </a>
          ))}
          <Link href="/login" className={cn("opacity-85 hover:opacity-100", linkFocus)}>
            Sign In
          </Link>
        </nav>
        <p className="text-sm opacity-75">© {new Date().getFullYear()} Team Balance Pro</p>
      </div>
    </footer>
  );
}

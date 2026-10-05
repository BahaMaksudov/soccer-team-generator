import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, KeyRound, Mail, MessageCircle, ShieldCheck, Ticket, UserRound } from "lucide-react";
import { listAccessibleTenants, requireSessionAccount, TenantContextError, type AccessibleOrganization } from "@/lib/tenantContext";
import { accountHasPassword } from "@/lib/changePassword";
import { isGoogleAuthConfigured } from "@/lib/googleAuth";
import { prisma } from "@/lib/prisma";
import { ROLE_LABELS } from "@/lib/appShell";
import { cn } from "@/lib/cn";
import ChangePasswordForm from "./ChangePasswordForm";

/**
 * M5.1 / UI-6 — Account. Any signed-in account, with or without an
 * Organization. Shows ONLY the account's own data: name, email and its
 * verification state, the real sign-in methods (password present or not;
 * Google only when the server has it configured), its OWN memberships and
 * roles, and the Players it has claimed (names, Group, Telegram connected
 * yes/no). Never ids, hashes, tokens or Telegram identities. Change Password
 * is unchanged (password accounts only).
 */
export const metadata = { title: "Account — Team Balance Pro" };

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card" aria-label={title}>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold">
        <span className="text-primary" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function AccountSecurityPage() {
  let account;
  let hasPassword: boolean;
  try {
    account = await requireSessionAccount();
    hasPassword = await accountHasPassword(account.id);
  } catch (e) {
    if (e instanceof TenantContextError) redirect("/login?callbackUrl=%2Faccount%2Fsecurity");
    throw e;
  }
  // Memberships and claimed Players only for a verified account (the central verified-email rule).
  let organizations: AccessibleOrganization[] = [];
  let players: Array<{ firstName: string; lastName: string; telegramConnected: boolean; group: string; organization: string }> = [];
  if (account.emailVerified) {
    organizations = await listAccessibleTenants();
    players = (
      await prisma.player.findMany({
        where: { userId: account.id, group: { isActive: true } },
        orderBy: { createdAt: "asc" },
        select: { firstName: true, lastName: true, telegramLink: { select: { id: true } }, group: { select: { name: true, organization: { select: { name: true } } } } },
      })
    ).map((p) => ({ firstName: p.firstName, lastName: p.lastName, telegramConnected: p.telegramLink.length > 0, group: p.group.name, organization: p.group.organization.name }));
  }
  const google = isGoogleAuthConfigured();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-extrabold">Account</h1>
      </header>

      <Card title="Profile" icon={<UserRound className="size-5" />}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Name</dt>
            <dd className="mt-0.5 font-semibold">{account.name ?? "—"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-semibold text-muted-foreground">Email</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="break-all font-semibold">{account.email}</span>
              <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", account.emailVerified ? "border-primary/25 bg-primary/10 text-primary" : "border-accent/40 bg-accent/10 text-accent-foreground")}>
                {account.emailVerified ? "Verified" : "Not verified"}
              </span>
            </dd>
          </div>
        </dl>
        {!account.emailVerified && (
          <Link href="/verify-email" className={cn("mt-3 inline-flex text-sm font-semibold text-primary hover:underline", focusRing)}>
            Verify your email
          </Link>
        )}
      </Card>

      <Card title="Sign-in methods" icon={<KeyRound className="size-5" />}>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {hasPassword ? "Email and password" : "No password — this account signs in with Google."}
          </li>
          {google && hasPassword && (
            <li className="flex items-center gap-2 text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              Continue with Google is also available for this verified email.
            </li>
          )}
        </ul>
      </Card>

      <Card title="Organizations" icon={<Building2 className="size-5" />}>
        {organizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">You&apos;re not a member of any organization.</p>
        ) : (
          <ul className="divide-y divide-border">
            {organizations.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{o.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {o.groups.length} {o.groups.length === 1 ? "group" : "groups"}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold text-secondary-foreground">{ROLE_LABELS[o.role]}</span>
                  <Link href={`/admin/o/${encodeURIComponent(o.slug)}`} className={cn("text-sm font-semibold text-primary hover:underline", focusRing)}>
                    Open<span className="sr-only"> {o.name}</span>
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Player profiles" icon={<Ticket className="size-5" />}>
        {players.length === 0 ? (
          <p className="text-sm text-muted-foreground">No player profile is connected to this account. Ask your organizer for a player claim link.</p>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {players.map((p, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0 text-sm">
                  <span className="min-w-0">
                    <span className="block font-semibold">
                      {p.firstName} {p.lastName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {p.group} · {p.organization}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MessageCircle className="size-4" aria-hidden="true" /> Telegram {p.telegramConnected ? "connected" : "not connected"}
                  </span>
                </li>
              ))}
            </ul>
            <Link href="/me" className={cn("mt-3 inline-flex text-sm font-semibold text-primary hover:underline", focusRing)}>
              Go to My Games
            </Link>
          </>
        )}
      </Card>

      <Card title="Change password" icon={<ShieldCheck className="size-5" />}>
        {hasPassword ? (
          <ChangePasswordForm />
        ) : (
          // UI-2 — Google-only account: there is no password to change.
          <p className="text-sm text-muted-foreground">You sign in with Google. This account has no password.</p>
        )}
      </Card>
    </div>
  );
}

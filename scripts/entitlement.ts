/**
 * M11.1 — operator tool: change ONE Organization's entitlement, audited.
 *
 *   npx tsx scripts/entitlement.ts --org <slug> --action grant-comp --reason "Founder org (approved by …)" --actor "you@example.com"
 *   npx tsx scripts/entitlement.ts --org <slug> --action trial --days 30 --reason "…" --actor "…"
 *   … --action revoke-comp | set-free
 *
 * Runs against DATABASE_URL — check which database that is first. Without
 * --confirm it only prints what WOULD change (dry run). Every applied change
 * writes an EntitlementEvent. Never deletes or deactivates anything.
 */
import { prisma } from "../src/lib/prisma";
import { changeEntitlement, effectivePlan, type EntitlementAction } from "../src/lib/entitlements";

const ACTIONS: EntitlementAction[] = ["grant-comp", "revoke-comp", "trial", "set-free"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("org");
  const action = arg("action") as EntitlementAction | undefined;
  const reason = arg("reason") ?? "";
  const actor = arg("actor") ?? "";
  const days = arg("days") ? Number(arg("days")) : undefined;
  if (!slug || !action || !ACTIONS.includes(action)) throw new Error(`Usage: --org <slug> --action ${ACTIONS.join("|")} [--days N] --reason "…" --actor "…" [--confirm]`);
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true, plan: true, trialEndsAt: true } });
  if (!org) throw new Error(`No Organization with slug "${slug}".`);
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "unknown";
    }
  })();
  console.log(`Database host: ${host}`);
  console.log(`Organization: ${org.name} (${slug}) — stored plan ${org.plan}, effective ${effectivePlan(org)}, trial ends ${org.trialEndsAt?.toISOString() ?? "—"}`);
  console.log(`Requested: ${action}${days ? ` (${days} days)` : ""} — reason: ${reason || "(missing)"} — actor: ${actor || "(missing)"}`);
  if (!process.argv.includes("--confirm")) {
    console.log("Dry run: nothing changed. Re-run with --confirm to apply.");
    return;
  }
  const updated = await changeEntitlement({ organizationId: org.id, action, reason, actor, days });
  console.log(`Applied: plan ${updated.plan}, trial ends ${updated.trialEndsAt?.toISOString() ?? "—"} (audited).`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

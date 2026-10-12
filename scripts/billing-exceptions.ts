/**
 * M11.2A — operator view of billing problems (read-only):
 *   npx tsx scripts/billing-exceptions.ts
 * Lists Stripe webhook events / reconcile checks that need attention
 * (EXCEPTION) or are still retrying (FAILED / RECEIVED), newest first.
 * Runs against DATABASE_URL — check which database that is first. Prints ids,
 * types and safe error text only (no card or customer personal data).
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "unknown";
    }
  })();
  console.log(`Database host: ${host}`);
  const rows = await prisma.stripeEvent.findMany({
    where: { status: { in: ["EXCEPTION", "FAILED", "RECEIVED"] } },
    orderBy: { receivedAt: "desc" },
    take: 100,
    select: { id: true, type: true, status: true, attempts: true, organizationId: true, objectId: true, error: true, receivedAt: true },
  });
  if (rows.length === 0) console.log("No open billing exceptions.");
  for (const r of rows) console.log(`${r.receivedAt.toISOString()}  ${r.status.padEnd(9)} ${r.type}  ${r.id}  org=${r.organizationId ?? "?"}  object=${r.objectId ?? "?"}  attempts=${r.attempts}  ${r.error ?? ""}`);
  console.log("Fix the cause, then run billing reconciliation (POST /api/cron/billing-reconcile) to re-apply from Stripe.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

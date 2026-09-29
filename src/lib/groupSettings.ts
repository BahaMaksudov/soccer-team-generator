import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { teamNameSchema, balanceWeightsSchema, zodErrorResponse } from "@/lib/validation";
import { DEFAULT_BALANCE_WEIGHTS, mergeBalanceWeights } from "@/lib/scoring";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.4 — shared Group-settings core (teamName, balanceWeights),
 * extracted verbatim from the legacy /api/admin/settings/team-name and
 * /api/admin/settings/balance-weights route bodies (only the tenant
 * resolution step was removed). The canonical URL-bound routes
 * (requireTenantContextForSlugs()) delegate here after resolving and
 * authorizing their own TenantContext (the legacy flat routes were
 * deleted in Phase 2D.6D.5E.5) — this module
 * never resolves tenancy itself and never reads request body/query
 * for ownership. It receives an already-authorized
 * `context.activeGroup.id` and uses nothing else for scoping.
 *
 * revalidatePath() is deliberately NOT called for the canonical
 * settings paths: inspection (Phase 2D.6D.4 report §"branding
 * integration") confirmed canonical public branding
 * (SiteHeader.tsx -> /api/public/[org]/[group]/team-name) is fetched
 * client-side with `{ cache: "no-store" }`, and canonical Generate
 * reads GroupSetting.balanceWeights fresh via Prisma on every
 * request — neither has a caching layer that would go stale, so no
 * new revalidation target exists to add. (Phase 2D.6D.5E.5 removed the
 * legacy-only page revalidation helpers together with the flat routes
 * that were their only callers.)
 */

const TEAM_NAME_KEY = "teamName";
const BALANCE_WEIGHTS_KEY = "balanceWeights";

export async function getTeamNameForContext(context: TenantContext): Promise<NextResponse> {
  const row = await prisma.groupSetting.findUnique({
    where: { groupId_key: { groupId: context.activeGroup.id, key: TEAM_NAME_KEY } },
  });

  // No cross-tenant/global fallback: a Group that hasn't set a custom
  // team name yet gets an empty value, not another tenant's name and
  // not the legacy global AppSetting row.
  return NextResponse.json({
    teamName: row?.value?.trim() || "",
  });
}

export async function saveTeamNameForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => ({}));

  const parsed = teamNameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const nextName = parsed.data.teamName;

  // Server determines group ownership — teamNameSchema has no
  // groupId field, so any client-supplied groupId/organizationId is
  // structurally stripped by safeParse before reaching here.
  await prisma.groupSetting.upsert({
    where: { groupId_key: { groupId: context.activeGroup.id, key: TEAM_NAME_KEY } },
    update: { value: nextName },
    create: { groupId: context.activeGroup.id, key: TEAM_NAME_KEY, value: nextName },
  });

  return NextResponse.json({ ok: true, teamName: nextName });
}

export async function getBalanceWeightsForContext(context: TenantContext): Promise<NextResponse> {
  const row = await prisma.groupSetting.findUnique({
    where: { groupId_key: { groupId: context.activeGroup.id, key: BALANCE_WEIGHTS_KEY } },
  });

  // No GroupSetting yet for this Group -> application defaults. Never
  // fall back to the legacy global AppSetting.balanceWeights row or
  // to another Group's row.
  if (!row?.value) {
    return NextResponse.json({ weights: DEFAULT_BALANCE_WEIGHTS });
  }

  try {
    const parsed = JSON.parse(row.value);
    // mergeBalanceWeights never throws — malformed/legacy stored
    // fields are safely ignored.
    return NextResponse.json({ weights: mergeBalanceWeights(parsed) });
  } catch {
    return NextResponse.json({ weights: DEFAULT_BALANCE_WEIGHTS });
  }
}

export async function saveBalanceWeightsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => ({}));

  const parsed = balanceWeightsSchema.safeParse(body?.weights);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid weights.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Normalize through mergeBalanceWeights so only the known,
  // currently meaningful fields are ever persisted.
  const weights = mergeBalanceWeights(parsed.data);

  // Server determines group ownership — balanceWeightsSchema has no
  // groupId field and this function never reads body.groupId at all.
  await prisma.groupSetting.upsert({
    where: { groupId_key: { groupId: context.activeGroup.id, key: BALANCE_WEIGHTS_KEY } },
    update: { value: JSON.stringify(weights) },
    create: { groupId: context.activeGroup.id, key: BALANCE_WEIGHTS_KEY, value: JSON.stringify(weights) },
  });

  return NextResponse.json({ ok: true, weights });
}

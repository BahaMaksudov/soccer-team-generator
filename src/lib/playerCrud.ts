import { prisma } from "@/lib/prisma";
import { assertCapacity, EntitlementError, planLimitResponse } from "@/lib/entitlements";
import { NextResponse } from "next/server";
import { playerCreateSchema, playerUpdateSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";
import { findSport, isValidRoleKey } from "@/lib/sports";
import { isManager, managersOnlyResponse } from "@/lib/tenantRoute";
import { resolveBalanceConfig } from "@/lib/balanceEngine";
import { loadStoredBalanceWeights } from "@/lib/groupSettings";
import { playerRating } from "@/lib/playerRating";

/**
 * Phase 2D.6D.1 — shared Player CRUD core, extracted verbatim from
 * the legacy /api/admin/players[/​[id]] route bodies (only the tenant
 * resolution step was removed — every remaining line of business
 * logic, validation, and Prisma call is unchanged). The canonical
 * URL-bound routes (resolving via requireTenantContextForSlugs())
 * delegate here after resolving and authorizing their TenantContext
 * (the legacy flat routes were deleted in Phase 2D.6D.5E.5) — this
 * module never resolves tenancy itself and never reads
 * request body/query parameters for ownership. It receives an
 * already-authorized `context.activeGroup.id` and uses nothing else
 * for scoping.
 */

// M6-C — organizer DTO: an explicit allow-list (never the raw row), so no
// account id, legacy Telegram columns or future fields leak. Account and
// Telegram state are exposed only as booleans.
const ADMIN_PLAYER_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  position: true,
  rating: true,
  stamina: true,
  isActive: true,
} as const;

type AdminPlayerRow = {
  id: string;
  firstName: string;
  lastName: string;
  position: string;
  rating: string;
  stamina: number;
  isActive: boolean;
  userId?: string | null;
  telegramLink?: Array<{ id: string }>;
  claims?: Array<{ id: string }>;
  communityPlayers?: Array<{ communityId: string }>;
};

function toAdminPlayer(p: AdminPlayerRow, staminaCoef = 1) {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position,
    rating: p.rating,
    stamina: p.stamina,
    isActive: p.isActive,
    accountClaimed: Boolean(p.userId),
    claimPending: (p.claims?.length ?? 0) > 0,
    telegramConnected: (p.telegramLink?.length ?? 0) > 0,
    // M9.2 — 0.0–10.0 rating from the balance engine's personal strength terms (organizer-only).
    playerRating: playerRating(p, staminaCoef),
    communityIds: communityIdsOf(p),
  };
}

const communityIdsOf = (p: AdminPlayerRow) => (p.communityPlayers ?? []).map((c) => c.communityId);

/** The Group's effective stamina coefficient (sport default + stored weights), for the displayed rating. */
async function staminaCoefFor(context: TenantContext): Promise<number> {
  const sport = findSport(context.activeGroup.sportKey);
  return sport ? resolveBalanceConfig(sport, await loadStoredBalanceWeights(context.activeGroup.id)).staminaCoef : 1;
}

/**
 * M7 — a role key is valid only for the Group's own sport (from the
 * URL-resolved context, never the request). An unknown sport fails closed.
 * Returns an error response, or null when the role is allowed.
 */
function roleError(context: TenantContext, position: string | undefined): NextResponse | null {
  if (position === undefined) return null;
  const sport = findSport(context.activeGroup.sportKey);
  if (!sport) return NextResponse.json({ error: "This group's sport is not supported." }, { status: 400 });
  if (!isValidRoleKey(sport, position)) {
    return NextResponse.json({ error: `Choose a valid ${sport.terminology.roleNoun.toLowerCase()} for ${sport.label}.` }, { status: 400 });
  }
  return null;
}

export async function listPlayers(context: TenantContext): Promise<NextResponse> {
  const players = await prisma.player.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      ...ADMIN_PLAYER_FIELDS,
      userId: true,
      telegramLink: { select: { id: true } },
      claims: { where: { usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } },
      communityPlayers: { select: { communityId: true } },
    },
  });
  // UI-7 — balancing data (skill / stamina) and organizer-only claim-link state
  // go to OWNER/ADMIN only; MEMBER receives the roster without them (absent from
  // the serialized response, not merely hidden in the UI). Role comes from the
  // URL-resolved, membership-verified context — never from the client.
  const manager = isManager(context);
  const staminaCoef = manager ? await staminaCoefFor(context) : 1;
  return NextResponse.json((players as AdminPlayerRow[]).map((p) => (manager ? toAdminPlayer(p, staminaCoef) : toMemberPlayer(p))));
}

/** UI-7 — MEMBER roster DTO: identity/status only; no rating, stamina or claim-link state. */
export function toMemberPlayer(p: AdminPlayerRow) {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position,
    isActive: p.isActive,
    accountClaimed: Boolean(p.userId),
    telegramConnected: (p.telegramLink?.length ?? 0) > 0,
    // M9.2 — Community memberships are roster data, not balancing data.
    communityIds: communityIdsOf(p),
  };
}

export async function createPlayer(context: TenantContext, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));

  // playerCreateSchema has no `groupId` field and is not .passthrough(),
  // so a client-supplied body.groupId is stripped during parsing below
  // and never reaches this point — ownership is set exclusively from
  // context.activeGroup.id a few lines down.
  const parsed = playerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { firstName, lastName, position, rating, isActive } = parsed.data;
  const stamina = parsed.data.stamina ?? 3;
  const invalidRole = roleError(context, position);
  if (invalidRole) return invalidRole;

  try {
    // M11.1 — an active Player counts toward the plan's unique active players (Organization-locked).
    const created = await prisma.$transaction(async (tx) => {
      if (isActive ?? true) await assertCapacity(tx, context.organization.id, "activePlayers");
      return tx.player.create({
        data: {
          firstName,
          lastName,
          position,
          rating,
          stamina,
          isActive: isActive ?? true,
          groupId: context.activeGroup.id,
        },
        select: { ...ADMIN_PLAYER_FIELDS, userId: true },
      });
    });

    return NextResponse.json(toAdminPlayer(created as AdminPlayerRow, await staminaCoefFor(context)));
  } catch (e: unknown) {
    if (e instanceof EntitlementError) return planLimitResponse(e);
    // Phase 2D.6E.6C — never return raw database/Prisma messages.
    console.error("createPlayer failed", e);
    return NextResponse.json({ error: "Failed to create player" }, { status: 500 });
  }
}

export async function updatePlayer(context: TenantContext, id: string, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));

  const parsed = playerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const groupId = context.activeGroup.id;
  const { firstName, lastName, position, rating, stamina, isActive } = parsed.data;
  const data = { firstName, lastName, position, rating, stamina, isActive };
  const invalidRole = roleError(context, position);
  if (invalidRole) return invalidRole;
  const hasChanges = Object.values(data).some((v) => v !== undefined);

  try {
    // Phase 2D.6E.6C — the tenant boundary is the mutation itself: one
    // statement scoped by BOTH id and the URL-resolved Group, never a
    // separate ownership check followed by a write by globally unique id.
    // A foreign-Group id and a nonexistent id both affect 0 rows and are
    // indistinguishable (plain 404, never 403).
    if (hasChanges) {
      // M11.1 — reactivating an inactive Player counts toward active players (Organization-locked).
      const result = await prisma.$transaction(async (tx) => {
        if (isActive === true) {
          const current = await tx.player.findFirst({ where: { id, groupId }, select: { isActive: true } });
          if (current && !current.isActive) await assertCapacity(tx, context.organization.id, "activePlayers");
        }
        return tx.player.updateMany({ where: { id, groupId }, data });
      });
      if (result.count !== 1) {
        return NextResponse.json({ error: "Player not found" }, { status: 404 });
      }
    }

    // Read back the Group-scoped row (never by id alone).
    const updated = await prisma.player.findFirst({
      where: { id, groupId },
      select: { ...ADMIN_PLAYER_FIELDS, userId: true, telegramLink: { select: { id: true } } },
    });
    if (!updated) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }
    return NextResponse.json(toAdminPlayer(updated as AdminPlayerRow, await staminaCoefFor(context)));
  } catch (e: unknown) {
    if (e instanceof EntitlementError) return planLimitResponse(e);
    console.error("updatePlayer failed", e);
    return NextResponse.json({ error: "Failed to update player" }, { status: 500 });
  }
}

export async function deletePlayer(context: TenantContext, id: string): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  try {
    // Phase 2D.6E.6C — single Group-scoped delete: the mutation itself
    // carries id AND the URL-resolved groupId. 0 rows (foreign or
    // nonexistent) → 404. The cascade to TelegramUserLink (onDelete:
    // Cascade, see prisma/schema.prisma) is unchanged.
    const result = await prisma.player.deleteMany({ where: { id, groupId: context.activeGroup.id } });
    if (result.count !== 1) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("deletePlayer failed", e);
    return NextResponse.json({ error: "Failed to delete player" }, { status: 500 });
  }
}

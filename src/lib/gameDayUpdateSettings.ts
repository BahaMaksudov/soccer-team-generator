import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { assertTelegram, EntitlementError, planLimitResponse } from "@/lib/entitlements";
import { zodErrorResponse } from "@/lib/validation";

/**
 * Phase 4B (step 4) — Telegram Game Day Update settings of one Group, stored
 * as ONE GroupSetting row (key "gameDayUpdate", JSON) — no migration. A Group
 * without the row (every existing and new Group) reads the defaults: OFF.
 *
 *   { enabled: false, hoursBefore: 4, includeWeather: true, units: "imperial" }
 *
 * Settings only — nothing is sent in this step. OWNER/ADMIN of the URL-bound
 * Group (MEMBER / foreign → the generic 404). Telegram is a plan capability:
 * turning updates ON needs Telegram in the Organization's plan (402 otherwise,
 * checked on the server); turning them OFF / changing preferences while off is
 * always allowed. Other GroupSetting rows are never touched.
 */
export const GAME_DAY_UPDATE_KEY = "gameDayUpdate";
export const GAME_DAY_UPDATE_HOURS = [2, 4, 6, 12] as const;
export const GAME_DAY_UPDATE_UNITS = ["imperial", "metric"] as const;

export type GameDayUpdateSettings = {
  enabled: boolean;
  hoursBefore: (typeof GAME_DAY_UPDATE_HOURS)[number];
  includeWeather: boolean;
  units: (typeof GAME_DAY_UPDATE_UNITS)[number];
};

export const GAME_DAY_UPDATE_DEFAULTS: GameDayUpdateSettings = { enabled: false, hoursBefore: 4, includeWeather: true, units: "imperial" };

export const gameDayUpdateSchema = z.object({
  enabled: z.boolean(),
  hoursBefore: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(12)], { message: "Choose 2, 4, 6 or 12 hours." }),
  includeWeather: z.boolean(),
  units: z.enum(GAME_DAY_UPDATE_UNITS, { message: "Choose imperial (°F, mph) or metric (°C, km/h)." }),
});

/** Stored value → settings; anything missing or malformed falls back to its default (per field). */
export function parseGameDayUpdateSettings(raw: string | null | undefined): GameDayUpdateSettings {
  let v: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
  } catch {
    v = {};
  }
  const d = GAME_DAY_UPDATE_DEFAULTS;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    hoursBefore: (GAME_DAY_UPDATE_HOURS as readonly unknown[]).includes(v.hoursBefore) ? (v.hoursBefore as GameDayUpdateSettings["hoursBefore"]) : d.hoursBefore,
    includeWeather: typeof v.includeWeather === "boolean" ? v.includeWeather : d.includeWeather,
    units: (GAME_DAY_UPDATE_UNITS as readonly unknown[]).includes(v.units) ? (v.units as GameDayUpdateSettings["units"]) : d.units,
  };
}

export async function readGameDayUpdateSettings(groupId: string): Promise<GameDayUpdateSettings> {
  const row = await prisma.groupSetting.findUnique({ where: { groupId_key: { groupId, key: GAME_DAY_UPDATE_KEY } }, select: { value: true } });
  return parseGameDayUpdateSettings(row?.value);
}

export type GameDayUpdateView = { settings: GameDayUpdateSettings; telegramAvailable: boolean; planMessage: string | null };

/** Settings + whether the Organization's plan includes Telegram (and the existing upgrade explanation when not). */
export async function gameDayUpdateView(context: TenantContext): Promise<GameDayUpdateView> {
  const settings = await readGameDayUpdateSettings(context.activeGroup.id);
  try {
    await assertTelegram(context.organization.id);
    return { settings, telegramAvailable: true, planMessage: null };
  } catch (e) {
    if (e instanceof EntitlementError) return { settings, telegramAvailable: false, planMessage: e.message };
    throw e;
  }
}

export async function getGameDayUpdateSettings(context: TenantContext): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  return NextResponse.json(await gameDayUpdateView(context));
}

export async function saveGameDayUpdateSettings(context: TenantContext, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  // The schema has no groupId / organizationId: any in the body is stripped; scoping is the URL-bound context only.
  const parsed = gameDayUpdateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  if (parsed.data.enabled) {
    try {
      await assertTelegram(context.organization.id);
    } catch (e) {
      if (e instanceof EntitlementError) return planLimitResponse(e);
      throw e;
    }
  }
  const value = JSON.stringify(parsed.data);
  await prisma.groupSetting.upsert({
    where: { groupId_key: { groupId: context.activeGroup.id, key: GAME_DAY_UPDATE_KEY } },
    update: { value },
    create: { groupId: context.activeGroup.id, key: GAME_DAY_UPDATE_KEY, value },
  });
  return NextResponse.json({ ok: true, settings: parsed.data });
}

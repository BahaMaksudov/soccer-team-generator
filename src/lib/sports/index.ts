import { soccer } from "./soccer";
import { basketball } from "./basketball";
import { volleyball } from "./volleyball";
import { flagFootball } from "./flagFootball";
import { other } from "./other";
import type { SportClientView, SportDefinition } from "./types";

export type { SportDefinition, SportRole, RoleRule, RoleRuleMode, ResultFormat, SportClientView } from "./types";

/**
 * M7 — the sport registry. Order is the order shown in sport pickers.
 * Keys are stable and persisted in Group.sportKey (immutable per Group).
 */
export const SPORTS: readonly SportDefinition[] = [soccer, basketball, volleyball, flagFootball, other];
export const SPORT_KEYS = SPORTS.map((s) => s.key) as [string, ...string[]];

const BY_KEY = new Map(SPORTS.map((s) => [s.key, s]));

export function isSportKey(key: unknown): key is string {
  return typeof key === "string" && BY_KEY.has(key);
}

/** The definition for a sport key, or undefined for an unknown key. */
export function findSport(key: string | null | undefined): SportDefinition | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

export class UnknownSportError extends Error {
  constructor() {
    super("This group's sport is not supported.");
    this.name = "UnknownSportError";
  }
}

/** Fail closed: writes and generation never guess a sport. */
export function requireSport(key: string | null | undefined): SportDefinition {
  const sport = findSport(key);
  if (!sport) throw new UnknownSportError();
  return sport;
}

export function isValidRoleKey(sport: SportDefinition, roleKey: unknown): roleKey is string {
  return typeof roleKey === "string" && sport.roles.some((r) => r.key === roleKey);
}

/**
 * Display label for a stored role key in a Group's sport. Unknown sport
 * or role (legacy data) → the raw key, never a guessed label from
 * another sport.
 */
export function roleLabel(sportKey: string | null | undefined, roleKey: string | null | undefined): string {
  if (!roleKey) return "";
  return findSport(sportKey)?.roles.find((r) => r.key === roleKey)?.label ?? roleKey;
}

export function rolePluralLabel(sport: SportDefinition, roleKey: string): string {
  return sport.roles.find((r) => r.key === roleKey)?.pluralLabel ?? roleKey;
}

export function newPlayerRoleKey(sport: Pick<SportDefinition, "newPlayerRoleKey" | "defaultRoleKey">): string {
  return sport.newPlayerRoleKey ?? sport.defaultRoleKey;
}

/** Plain, serializable view for client components. */
export function sportClientView(sport: SportDefinition): SportClientView {
  return {
    key: sport.key,
    label: sport.label,
    roles: sport.roles,
    newPlayerRoleKey: sport.newPlayerRoleKey,
    defaultRoleKey: sport.defaultRoleKey,
    roleRules: sport.roleRules,
    terminology: sport.terminology,
    defaults: sport.defaults,
  };
}

/** Sport-aware messaging vocabulary (M9/M10 content; generic code reads it from here). */
export function sportMessaging(key: string | null | undefined) {
  return (findSport(key) ?? other).messaging;
}

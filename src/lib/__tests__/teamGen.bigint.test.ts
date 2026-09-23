import { describe, it, expect } from "vitest";
import { generateBalancedTeams, type GeneratorPlayer } from "../teamGen";

/**
 * Mirrors exactly what /api/admin/generate's Prisma `select` now
 * returns — only the fields the generator/preview need, explicitly
 * excluding telegramUserId (BigInt) and every other Telegram-linking
 * field. No Prisma/DB call here; this is a plain projection so the
 * mapping behavior itself is testable in isolation.
 */
function toGeneratorPlayerDTO(full: Record<string, unknown>): GeneratorPlayer {
  return {
    id: full.id as string,
    firstName: full.firstName as string,
    lastName: full.lastName as string,
    position: full.position as GeneratorPlayer["position"],
    rating: full.rating as GeneratorPlayer["rating"],
    stamina: full.stamina as number,
  };
}

function seededRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A record shaped like a FULL Prisma Player row for a Telegram-linked
 * player — i.e. what /api/admin/generate used to fetch before the fix
 * (no `select`), including the BigInt field that broke it. */
function makeFullLinkedPlayerRecord(i: number) {
  return {
    id: `p${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    position: i % 4 === 0 ? "GOALKEEPER" : "MIDFIELDER",
    rating: "GOOD",
    stamina: 3,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Set once an admin links this player via /admin/telegram/link —
    // this is the field that previously reached NextResponse.json().
    telegramUserId: BigInt(1000000000 + i),
    telegramUsername: `user${i}`,
    telegramFirst: `First${i}`,
    telegramLast: `Last${i}`,
  };
}

describe("REGRESSION: Telegram-linked players (BigInt) can no longer break /api/admin/generate's JSON response", () => {
  it("documents the underlying danger: a full Player-shaped record with a linked Telegram id cannot be JSON.stringify'd directly", () => {
    const fullRecord = makeFullLinkedPlayerRecord(1);
    expect(() => JSON.stringify(fullRecord)).toThrow(TypeError);
  });

  it("the DTO produced by the generate route's select contains no BigInt and serializes safely", () => {
    const fullRecord = makeFullLinkedPlayerRecord(1);
    const dto = toGeneratorPlayerDTO(fullRecord);

    expect(() => JSON.stringify(dto)).not.toThrow();
    expect(JSON.stringify(dto)).not.toContain("telegramUserId");
    expect(dto).not.toHaveProperty("telegramUserId");
    expect(dto).not.toHaveProperty("telegramUsername");
  });

  it("generateBalancedTeams' full response body serializes safely even when EVERY selected player is Telegram-linked", () => {
    // The most common real workflow: importing "Playing" voters from a
    // Telegram poll selects exactly the players who have
    // telegramUserId set — so this is the realistic case, not an edge
    // case.
    const fullRecords = Array.from({ length: 8 }, (_, i) => makeFullLinkedPlayerRecord(i));
    const players = fullRecords.map(toGeneratorPlayerDTO);

    const teams = generateBalancedTeams(players, 2, undefined, undefined, seededRng(1));

    // Exactly the shape /api/admin/generate returns via NextResponse.json().
    const responseBody = { date: "2026-09-28T00:00:00.000Z", teams };

    let serialized: string | undefined;
    expect(() => {
      serialized = JSON.stringify(responseBody);
    }).not.toThrow();

    expect(serialized).toBeDefined();
    expect(serialized).not.toMatch(/telegramUserId/);
    expect(serialized).not.toMatch(/telegramUsername/);

    // Round-trip: nobody was silently dropped, and only the safe DTO
    // fields survive.
    const parsed = JSON.parse(serialized as string);
    const allPlayers = parsed.teams.flatMap((t: { players: unknown[] }) => t.players);
    expect(allPlayers).toHaveLength(8);
    for (const p of allPlayers as Record<string, unknown>[]) {
      expect(p).toHaveProperty("id");
      expect(p).toHaveProperty("firstName");
      expect(p).toHaveProperty("lastName");
      expect(p).toHaveProperty("position");
      expect(p).not.toHaveProperty("telegramUserId");
      expect(p).not.toHaveProperty("telegramUsername");
    }
  });
});

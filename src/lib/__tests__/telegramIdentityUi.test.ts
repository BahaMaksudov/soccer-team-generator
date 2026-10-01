import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import PlayerTelegramCell from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/PlayerTelegramCell";
import CanonicalPlayersSection from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalPlayersSection";
import ConnectTelegram from "@/app/me/ConnectTelegram";
import { sportClientView } from "@/lib/sports";
import { soccer } from "@/lib/sports/soccer";
import type { Player } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalAdminWorkspace";

const PLAYER: Player = { id: "p1", firstName: "test", lastName: "one", position: "FORWARD", rating: "GOOD", stamina: 3, isActive: true };
const noop = () => {};
const cell = (p: Player) =>
  renderToStaticMarkup(createElement(PlayerTelegramCell, { organizationSlug: "o", groupSlug: "g", player: p, onChanged: noop, onMessage: noop }));

describe("M6.1 organizer Telegram cell", () => {
  it("connected → 'Connected' + 'Remove Telegram link' (a boolean only, no Telegram id)", () => {
    const html = cell({ ...PLAYER, telegramConnected: true });
    expect(html).toContain("Connected");
    expect(html).toContain("Remove Telegram link");
  });
  it("not connected → no remove action", () => {
    const html = cell({ ...PLAYER, telegramConnected: false });
    expect(html).toContain("Not connected");
    expect(html).not.toContain("Remove");
  });
  it("the Players table has a Telegram column rendering the cell per row", () => {
    const html = renderToStaticMarkup(
      createElement(CanonicalPlayersSection, {
        organizationSlug: "o",
        groupSlug: "g",
        players: [{ ...PLAYER, telegramConnected: true }],
        loading: false,
        selected: {},
        onToggleSelected: noop,
        onSelectAllActive: noop,
        onMessage: noop,
        refreshPlayers: noop,
        sport: sportClientView(soccer),
      })
    );
    expect(html).toMatch(/<th[^>]*>Telegram<\/th>/);
    expect(html).toContain("Remove Telegram link");
  });
});

describe("M6.1 /me Telegram control", () => {
  it("connected → 'Disconnect Telegram' (no connect button)", () => {
    const html = renderToStaticMarkup(createElement(ConnectTelegram, { playerId: "p1", connected: true }));
    expect(html).toContain("Disconnect Telegram");
    expect(html).not.toContain("Connect Telegram<");
  });
  it("not connected → 'Connect Telegram'", () => {
    const html = renderToStaticMarkup(createElement(ConnectTelegram, { playerId: "p1", connected: false }));
    expect(html).toContain("Connect Telegram");
    expect(html).not.toContain("Disconnect");
  });
});

describe("M6.1 invariant: link removal is Group-scoped, never by Telegram user id alone", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/telegramIdentity.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("every TelegramUserLink delete is addressed by playerId AND groupId", () => {
    const deletes = src.match(/telegramUserLink\.delete\w*\(\{[^)]*\)/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d).toMatch(/playerId/);
      expect(d).toMatch(/groupId/);
      expect(d).not.toMatch(/userId/);
    }
  });
  it("organizer removal requires OWNER/ADMIN; never calls Telegram", () => {
    expect(src).toContain('requireRole(context, ["OWNER", "ADMIN"])');
    expect(src).not.toMatch(/callTelegram|fetch\(/);
  });
});

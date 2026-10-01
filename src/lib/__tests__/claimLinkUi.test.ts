import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sportClientView } from "@/lib/sports";
import { soccer } from "@/lib/sports/soccer";
import { accountCellState, claimUrlFromResponse, createClaimLinkFlow } from "@/lib/claimLinkUi";
import PlayerAccountCell from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/PlayerAccountCell";
import CanonicalPlayersSection from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalPlayersSection";
import type { Player } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalAdminWorkspace";

const ORIGIN = "https://teambalancepro.com";
const T1 = "A".repeat(43);
const T2 = "B".repeat(43);
const PLAYER: Player = { id: "p1", firstName: "test", lastName: "one", position: "FORWARD", rating: "GOOD", stamina: 3, isActive: true };

/** Section-level transient store, as CanonicalPlayersSection keeps it (survives row remounts). */
function sectionStore() {
  const links: Record<string, string> = {};
  return { links, remember: (id: string, url: string) => (links[id] = url) };
}

describe("Production bug reproduction: Create claim link → list refresh → link must still be copyable", () => {
  it("the URL is stored in section state BEFORE the refresh that re-renders the rows", async () => {
    const store = sectionStore();
    const order: string[] = [];
    let listAfterRefresh: Player = { ...PLAYER };
    const result = await createClaimLinkFlow({
      request: async () => ({ ok: true, data: { claimPath: `/claim#${T1}`, claimUrl: `${ORIGIN}/claim#${T1}` } }),
      origin: ORIGIN,
      rememberLink: (url) => {
        order.push("remember");
        store.remember(PLAYER.id, url);
      },
      refresh: async () => {
        order.push("refresh");
        // What Production did next: the list reloads and now reports a pending claim.
        listAfterRefresh = { ...PLAYER, claimPending: true };
      },
    });
    expect(result).toEqual({ ok: true, url: `${ORIGIN}/claim#${T1}` });
    expect(order).toEqual(["remember", "refresh"]);
    // After the refresh the row still shows the one-time link (not "Claim link sent").
    expect(accountCellState(listAfterRefresh, store.links[PLAYER.id])).toBe("link_ready");
    const html = renderToStaticMarkup(
      createElement(PlayerAccountCell, {
        organizationSlug: "org", groupSlug: "grp", player: listAfterRefresh, oneTimeLink: store.links[PLAYER.id],
        onLinkCreated: vi.fn(), onLinkCleared: vi.fn(), onChanged: vi.fn(), onMessage: vi.fn(),
      })
    );
    expect(html).toContain("Claim link created — copy it now. It will not be shown again.");
    expect(html).toContain(`value="${ORIGIN}/claim#${T1}"`);
    expect(html).toContain("Copy claim link");
  });

  it("New link (replacement) shows the NEW URL immediately", async () => {
    const store = sectionStore();
    store.remember(PLAYER.id, `${ORIGIN}/claim#${T1}`);
    await createClaimLinkFlow({
      request: async () => ({ ok: true, data: { claimPath: `/claim#${T2}`, claimUrl: `${ORIGIN}/claim#${T2}` } }),
      origin: ORIGIN,
      rememberLink: (url) => store.remember(PLAYER.id, url),
      refresh: async () => {},
    });
    expect(store.links[PLAYER.id]).toBe(`${ORIGIN}/claim#${T2}`);
  });

  it("a failed request shows an error and never stores or refreshes", async () => {
    const remember = vi.fn();
    const refresh = vi.fn();
    const r = await createClaimLinkFlow({ request: async () => ({ ok: false, data: { error: "This player is already claimed by an account." } }), origin: ORIGIN, rememberLink: remember, refresh });
    expect(r).toEqual({ ok: false, error: "This player is already claimed by an account." });
    expect(remember).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("after a real reload (empty transient state) the row returns to 'Claim link sent' and shows no URL", () => {
    expect(accountCellState({ claimPending: true }, undefined)).toBe("pending");
    const html = renderToStaticMarkup(
      createElement(PlayerAccountCell, {
        organizationSlug: "org", groupSlug: "grp", player: { ...PLAYER, claimPending: true }, oneTimeLink: null,
        onLinkCreated: vi.fn(), onLinkCleared: vi.fn(), onChanged: vi.fn(), onMessage: vi.fn(),
      })
    );
    expect(html).toContain("Claim link sent");
    expect(html).toContain("New link");
    expect(html).toContain("Revoke");
    expect(html).not.toContain("/claim#");
  });

  it("a claimed Player never shows a leftover link", () => {
    expect(accountCellState({ accountClaimed: true }, `${ORIGIN}/claim#${T1}`)).toBe("claimed");
  });
});

describe("Players section keeps rows mounted during a refresh (root cause)", () => {
  const props = (loading: boolean, players: Player[]) => ({
    organizationSlug: "org", groupSlug: "grp", players, loading, selected: {},
    onToggleSelected: vi.fn(), onSelectAllActive: vi.fn(), onMessage: vi.fn(), refreshPlayers: vi.fn(),
    sport: sportClientView(soccer),
  });

  it("a refresh of an existing list (loading=true) still renders the table and account cells", () => {
    const html = renderToStaticMarkup(createElement(CanonicalPlayersSection, props(true, [{ ...PLAYER, claimPending: true }])));
    expect(html).toContain("<td>test one</td>");
    expect(html).toContain("Claim link sent");
    expect(html).not.toContain("Loading…");
  });

  it("only the very first load (no players yet) shows Loading…", () => {
    expect(renderToStaticMarkup(createElement(CanonicalPlayersSection, props(true, [])))).toContain("Loading…");
  });
});

describe("claimUrlFromResponse", () => {
  it("prefers the server's canonical claimUrl; falls back to origin + claimPath", () => {
    expect(claimUrlFromResponse({ claimUrl: `${ORIGIN}/claim#${T1}`, claimPath: `/claim#${T1}` }, "http://other")).toBe(`${ORIGIN}/claim#${T1}`);
    expect(claimUrlFromResponse({ claimUrl: null, claimPath: `/claim#${T1}` }, ORIGIN)).toBe(`${ORIGIN}/claim#${T1}`);
  });
  it("rejects anything that is not exactly a /claim#<token> link", () => {
    for (const bad of [
      { claimUrl: `${ORIGIN}/claim?token=${T1}` },
      { claimUrl: `${ORIGIN}/api/admin/x/claim#${T1}` },
      { claimPath: `/claim#short` },
      { claimPath: `//evil.example/claim#${T1}` },
      {},
      null,
    ]) {
      expect(claimUrlFromResponse(bad, ORIGIN)).toBeNull();
    }
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { playerFacingViewUrl } from "@/lib/messaging/links";
import { canonicalMatchPath, shareMatchPath } from "@/lib/matchPaths";

const env = { APP_BASE_URL: "https://teambalancepro.com" };
const base = { organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer", env };
const TOKEN = "A".repeat(43);
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("M9-C — Telegram 'View teams online' URL", () => {
  it("PUBLIC + matchId → the canonical Match page of exactly that Match; same-day Matches differ", () => {
    const a = playerFacingViewUrl({ ...base, visibility: "PUBLIC", matchId: "match-a" });
    const b = playerFacingViewUrl({ ...base, visibility: "PUBLIC", matchId: "match-b" });
    expect(a).toBe("https://teambalancepro.com/g/new-england-eagles/indoor-soccer/m/match-a");
    expect(b).toBe("https://teambalancepro.com/g/new-england-eagles/indoor-soccer/m/match-b");
  });
  it("legacy (no matchId) keeps the Group page", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "PUBLIC" })).toBe("https://teambalancepro.com/g/new-england-eagles/indoor-soccer");
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", shareUrl: `https://teambalancepro.com/share#${TOKEN}` })).toBe(`https://teambalancepro.com/share#${TOKEN}`);
  });
  it("LINK + matchId → /share/m/<matchId>#<token> from a supplied share link only; anything else → no link", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", matchId: "match-a", shareUrl: `https://teambalancepro.com/share#${TOKEN}` })).toBe(
      `https://teambalancepro.com/share/m/match-a#${TOKEN}`
    );
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", matchId: "match-a" })).toBeNull();
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", matchId: "match-a", shareUrl: `https://evil.example/share#${TOKEN}` })).toBeNull();
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", matchId: "match-a", shareUrl: "https://teambalancepro.com/share#" })).toBeNull();
  });
  it("PRIVATE → never a link", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "PRIVATE", matchId: "match-a", shareUrl: `https://teambalancepro.com/share#${TOKEN}` })).toBeNull();
  });
  it("path helpers encode segments and keep the token in the fragment", () => {
    expect(canonicalMatchPath("o", "g", "a/b")).toBe("/g/o/g/m/a%2Fb");
    expect(shareMatchPath("m1", TOKEN)).toBe(`/share/m/m1#${TOKEN}`);
  });
});

describe("M9-C — page wiring", () => {
  it("Match pages are never indexed and send no Referer", () => {
    for (const f of ["src/app/g/[organizationSlug]/[groupSlug]/m/[matchId]/page.tsx", "src/app/share/m/[matchId]/page.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("robots: { index: false, follow: false }");
      expect(src, f).toContain(`referrer: "no-referrer"`);
    }
    expect(read("src/app/api/share/match/route.ts")).toContain(`"X-Robots-Tag": "noindex, nofollow"`);
  });
  it("the share token is read from the URL fragment and sent only in a POST body", () => {
    const client = read("src/app/share/m/[matchId]/ShareMatchView.tsx");
    expect(client).toContain(`window.location.hash`);
    expect(client).toContain(`body: JSON.stringify({ token, matchId })`);
    expect(client).not.toMatch(/console\.|searchParams|\?token=/);
  });
  it("Telegram identity is never browser authentication: the Match page code reads no Telegram data", () => {
    const lib = read("src/lib/matchPage.ts");
    expect(lib).not.toMatch(/telegramUserLink|telegramPollAnswer|telegramUserId|searchParams/);
    expect(lib).toContain("resolveGroupForViewer");
  });
  it("client code imports the DTO type only (no server modules in the bundle)", () => {
    for (const f of ["src/app/share/m/[matchId]/ShareMatchView.tsx", "src/app/components/PlayerMatchCard.tsx"]) {
      expect(read(f), f).toMatch(/import type \{ PlayerMatchView \} from "@\/lib\/matchPage";/);
    }
  });
});

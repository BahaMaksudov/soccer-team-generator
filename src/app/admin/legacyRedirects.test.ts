import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6D.5E.2 — /admin/telegram and /admin/settings are retired
 * and only forward to bare /admin, which owns tenant selection.
 */

const mockRedirect = vi.fn((url: string) => {
  // next/navigation's redirect() throws to abort rendering.
  throw Object.assign(new Error("NEXT_REDIRECT"), { url });
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));

import LegacyTelegramPage from "./telegram/page";
import LegacySettingsPage from "./settings/page";

const adminDir = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(adminDir, rel), "utf8");

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

beforeEach(() => {
  mockRedirect.mockClear();
});

describe("retired legacy Admin pages redirect to /admin", () => {
  const pages: Record<string, () => unknown> = {
    "/admin/telegram": LegacyTelegramPage,
    "/admin/settings": LegacySettingsPage,
  };

  it.each(Object.keys(pages))("%s → /admin", (route) => {
    expect(() => pages[route]()).toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith("/admin");
  });

  it.each(["telegram/page.tsx", "settings/page.tsx"])(
    "%s is a server redirect only: no client code, no fetch, no tenant slug or default config",
    (file) => {
      const code = stripComments(read(file));
      expect(code).not.toMatch(/["']use client["']/);
      expect(code).not.toMatch(/fetch\(|\/api\//);
      expect(code).not.toMatch(
        /DEFAULT_PUBLIC|getDefaultPublicGroupSlugs|new-england-eagles|indoor-soccer|\/admin\/o\/|cookies|localStorage/
      );
      expect([...code.matchAll(/redirect\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"/admin"']);
    }
  );
});

describe("/admin/legacy-workspace is still operational (not redirected)", () => {
  it("renders AdminWorkspace and does not redirect", () => {
    const code = stripComments(read("legacy-workspace/page.tsx"));
    expect(code).toContain("<AdminWorkspace />");
    expect(code).not.toMatch(/redirect\(/);
  });

  it("legacy components no longer link to the retired pages", () => {
    for (const f of ["components/AdminWorkspace.tsx", "components/PlayerSelection.tsx"]) {
      expect(stripComments(read(f)), f).not.toMatch(/(?<!\/api)\/admin\/(telegram|settings)\b/);
    }
  });

  it("legacy Telegram import/linking and settings sections are still wired", () => {
    const ws = read("components/AdminWorkspace.tsx");
    expect(ws).toContain("<TelegramPollImport");
    expect(ws).toContain("<TelegramUserLinks");
    expect(ws).toContain("<TeamSettings");
    expect(ws).toContain('fetch("/api/admin/telegram/import"');
  });
});

describe("canonical Admin still provides the retired pages' capabilities", () => {
  const canonical = "o/[organizationSlug]/g/[groupSlug]/";
  const workspace = read(canonical + "CanonicalAdminWorkspace.tsx");
  const telegram = read(canonical + "CanonicalTelegramSection.tsx");
  const settings = read(canonical + "CanonicalSettingsSection.tsx");

  it("workspace renders both Telegram and Settings sections", () => {
    expect(workspace).toContain("<CanonicalTelegramSection");
    expect(workspace).toContain("<CanonicalSettingsSection");
  });

  it.each([
    "/telegram/chats",
    "/telegram/polls",
    "/telegram/users",
    "/telegram/create-poll",
    "/telegram/import",
    "/telegram/link",
    "/telegram/close-and-post",
  ])("Telegram section uses canonical %s", (p) => {
    expect(telegram).toMatch(new RegExp(`path: [^\\n]*"${p.replace(/[/-]/g, "\\$&")}`));
  });

  it.each(["/settings/team-name", "/settings/balance-weights"])("Settings section uses canonical %s", (p) => {
    expect(settings).toContain(`path: "${p}"`);
  });
});

describe("5E.1 remains intact", () => {
  it("flat Publish still passes allowTelegramPollActions: false", () => {
    const route = fs.readFileSync(path.resolve(adminDir, "../api/admin/publish/route.ts"), "utf8");
    expect(route).toContain("allowTelegramPollActions: false");
    expect(route).not.toContain("allowTelegramPollActions: true");
  });
});

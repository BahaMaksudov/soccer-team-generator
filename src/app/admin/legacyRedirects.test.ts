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
import LegacyWorkspacePage from "./legacy-workspace/page";

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
    "/admin/legacy-workspace": LegacyWorkspacePage,
  };

  it.each(Object.keys(pages))("%s → /admin", (route) => {
    expect(() => pages[route]()).toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith("/admin");
  });

  it.each(["telegram/page.tsx", "settings/page.tsx", "legacy-workspace/page.tsx"])(
    "%s is a server redirect only: no client code, no fetch, no tenant slug or default config",
    (file) => {
      const code = stripComments(read(file));
      expect(code).not.toMatch(/["']use client["']/);
      expect(code).not.toMatch(/fetch\(|\/api\//);
      expect(code).not.toMatch(
        /DEFAULT_PUBLIC|getDefaultPublicGroupSlugs|new-england-eagles|indoor-soccer|\/admin\/o\/|cookies|localStorage|sessionStorage|process\.env/
      );
      expect([...code.matchAll(/redirect\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"/admin"']);
    }
  );
});

describe("/admin/legacy-workspace is retired (Phase 2D.6D.5E.4)", () => {
  it("no longer imports or renders AdminWorkspace", () => {
    const code = stripComments(read("legacy-workspace/page.tsx"));
    expect(code).not.toMatch(/import[^;]*AdminWorkspace|<AdminWorkspace|components\//);
    expect([...code.matchAll(/^import .*$/gm)].map((m) => m[0])).toEqual(['import { redirect } from "next/navigation";']);
    expect(code).not.toMatch(/<[A-Z]/);
  });

  it("no production page or route imports AdminWorkspace any more", () => {
    const srcDir = path.resolve(adminDir, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts") && !full.endsWith("AdminWorkspace.tsx")) {
          if (/from\s+["'][^"']*\/AdminWorkspace["']/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

// Legacy components stay in source (now unreachable) until the 5E.5
// dead-code/API deletion; these only pin their current shape.
describe("legacy components retained in source until 5E.5", () => {
  it("legacy components no longer link to the retired pages", () => {
    for (const f of ["components/AdminWorkspace.tsx", "components/PlayerSelection.tsx"]) {
      expect(stripComments(read(f)), f).not.toMatch(/(?<!\/api)\/admin\/(telegram|settings)\b/);
    }
  });

  it("AdminWorkspace source is unchanged in shape (import/linking/settings still wired)", () => {
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

  it("workspace renders Players, Generate, Settings and Telegram sections", () => {
    expect(workspace).toContain("<CanonicalPlayersSection");
    expect(workspace).toContain("<CanonicalGenerateSection");
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

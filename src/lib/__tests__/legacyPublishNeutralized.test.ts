import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6D.5E.1 — source-level guarantees that legacy Publish can no
 * longer trigger Telegram side effects, and that no live route opts
 * back in. (Node-only vitest; no React renderer — same approach as
 * canonicalCloseAndPostWiring.test.ts.)
 */

const root = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

const workspace = read("src/app/admin/components/AdminWorkspace.tsx");

describe("legacy AdminWorkspace.publish() is Telegram-free", () => {
  const publishFn = stripComments(
    workspace.slice(workspace.indexOf("async function publish()"), workspace.indexOf("function clearPreview()"))
  );

  it("posts only { date, teams } to the flat publish route", () => {
    expect(publishFn).toContain('fetch("/api/admin/publish"');
    expect(publishFn).toMatch(/JSON\.stringify\(\{\s*date: previewDate,\s*teams: previewTeams,\s*\}\)/);
  });

  it("never sends pollId, closePoll, or postToTelegram", () => {
    // The request itself: from fetch( up to the response read. (Later
    // lines only render the server's pollStatus banner text.)
    const request = publishFn.slice(publishFn.indexOf('fetch("/api/admin/publish"'), publishFn.indexOf("await res.json()"));
    expect(request).toContain("body: JSON.stringify");
    expect(request).not.toMatch(/pollId|closePoll|postToTelegram|pollIdInput|importedPollId/);
    // …and publish() no longer reads any poll-selection state at all.
    expect(publishFn).not.toMatch(/\b(pollIdInput|importedPollId|selectedPollId)\b/);
  });

  it("Telegram poll import is still wired (not removed in 5E.1)", () => {
    expect(workspace).toContain('fetch("/api/admin/telegram/import"');
    expect(workspace).toContain("<TelegramPollImport");
  });
});

describe("no live route enables Telegram poll actions", () => {
  const sources = walk("src").map((f) => ({ f, code: stripComments(read(f)) }));

  it("no production source passes allowTelegramPollActions: true", () => {
    const offenders = sources.filter(({ code }) => /allowTelegramPollActions:\s*true/.test(code)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it("every publishTeamsForContext caller is a Publish route passing allowTelegramPollActions: false", () => {
    const callers = sources
      .filter(({ f, code }) => f !== path.join("src", "lib", "publishTeams.ts") && /publishTeamsForContext\(/.test(code))
      .map(({ f, code }) => ({ f, flags: [...code.matchAll(/allowTelegramPollActions:\s*(\w+)/g)].map((m) => m[1]) }));

    expect(callers.map((c) => c.f).sort()).toEqual(
      [
        path.join("src", "app", "api", "admin", "publish", "route.ts"),
        path.join("src", "app", "api", "admin", "o", "[organizationSlug]", "g", "[groupSlug]", "publish", "route.ts"),
      ].sort()
    );
    for (const c of callers) expect(c.flags).toEqual(["false"]);
  });
});

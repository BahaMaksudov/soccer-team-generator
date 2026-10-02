import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6D.5D — source-level wiring checks for the canonical Admin
 * tree (this repo's vitest runs in node with no React renderer). They
 * pin the state flow and endpoint choices the pure helpers can't see.
 */

const root = path.resolve(__dirname, "../../..");
const canonicalUiDir = path.join(root, "src/app/admin/o/[organizationSlug]/g/[groupSlug]");
const read = (p: string) => fs.readFileSync(p, "utf8");

const workspace = read(path.join(canonicalUiDir, "CanonicalAdminWorkspace.tsx"));
const generate = read(path.join(canonicalUiDir, "CanonicalGenerateSection.tsx"));
const telegram = read(path.join(canonicalUiDir, "CanonicalTelegramSection.tsx"));

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("canonical Admin tree — no flat Admin API", () => {
  it("no canonical UI file references a flat /api/admin/ URL", () => {
    for (const f of fs.readdirSync(canonicalUiDir).filter((n) => n.endsWith(".tsx"))) {
      const code = stripComments(read(path.join(canonicalUiDir, f)));
      expect(code, f).not.toMatch(/["'`]\/api\/admin\//);
    }
  });
});

describe("canonical Close Poll & Post Teams wiring", () => {
  it("Telegram section calls only the canonical close-and-post endpoint with ids only", () => {
    expect(telegram).toMatch(/adminTenantApiPath\(\{[^}]*path: "\/telegram\/close-and-post"/);
    expect(telegram).toMatch(/pollId: closePostPoll\.pollId, teamGenerationId: publishedGeneration\.id/);
    expect(stripComments(telegram)).not.toMatch(/teams:/);
  });

  it("Close/Post eligibility and preselection read only persistedPollDate, never the question-derived pollDate", () => {
    const closePost = telegram.slice(
      telegram.indexOf("// --- Close Poll & Post Teams ---"),
      telegram.indexOf("// --- Link Users ---")
    );
    expect(closePost).toContain("poll: closePostPoll,");
    expect(closePost).toContain("persistedPollDate === publishedGeneration.date");
    expect(closePost).not.toMatch(/\.pollDate\b/);
    expect(closePost).not.toMatch(/\bpollDate:/);
  });

  it("canonical Close/Post never sends the legacy extra poll-closed chat message", () => {
    const core = stripComments(read(path.join(root, "src/lib/telegramCloseAndPost.ts")));
    expect(core).not.toMatch(/Poll is closed|Poll is already closed/);
    const methods = [...core.matchAll(/callTelegram\("(\w+)"/g)].map((m) => m[1]);
    expect(methods).toEqual(["stopPoll", "sendMessage"]);
  });

  it("action is labelled distinctly from Publish", () => {
    expect(telegram).toContain("Close Poll & Post Teams to Telegram");
  });

  it("workspace owns publishedGeneration and passes it to both sections", () => {
    expect(workspace).toMatch(/useState<PublishedGeneration \| null>\(null\)/);
    expect(workspace).toContain("onPublishedGenerationChange={setPublishedGeneration}");
    expect(workspace).toContain("publishedGeneration={publishedGeneration}");
  });

  it("Publish success reports the saved TeamGeneration id up to the workspace", () => {
    expect(generate).toContain("onPublishedGenerationChange(publishedGenerationFromPublishResponse(data, previewDate))");
  });

  // M9-A (manual-smoke fix): the published teams stay published until a new
  // Publish or a delete — regenerating/clearing a PREVIEW must not make the
  // workspace forget them (Close & Post targets what players actually see).
  it("Generate and Clear keep the current publishedGeneration (preview-only actions)", () => {
    const generateFn = generate.slice(generate.indexOf("async function generate()"), generate.indexOf("function clearPreview()"));
    const clearFn = generate.slice(generate.indexOf("function clearPreview()"), generate.indexOf("async function publish()"));
    expect(generateFn).not.toContain("onPublishedGenerationChange(");
    expect(clearFn).not.toContain("onPublishedGenerationChange(");
  });

  it("canonical Publish request stays Telegram-free (no pollId/closePoll/postToTelegram)", () => {
    const publishFn = generate.slice(generate.indexOf("async function publish()"));
    // M9-A: a Match-mode publish adds only the matchId (validated server-side) — still no Telegram fields.
    expect(publishFn).toContain("JSON.stringify(matchId ? { date: previewDate, teams: previewTeams, matchId } : { date: previewDate, teams: previewTeams })");
    expect(stripComments(generate)).not.toMatch(/pollId|closePoll|postToTelegram/);
  });

  it("canonical Publish route delegates to the DB-only core with no Telegram option (Phase 2D.6D.5E.5)", () => {
    const route = stripComments(read(path.join(root, "src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route.ts")));
    expect(route).toContain("return publishTeamsForContext(context, req);");
    expect(route).not.toContain("allowTelegramPollActions");
    // The flat legacy Publish route no longer exists at all.
    expect(fs.existsSync(path.join(root, "src/app/api/admin/publish/route.ts"))).toBe(false);
  });

  it("publishTeams.ts does not touch the canonical posting state or Telegram", () => {
    const core = stripComments(read(path.join(root, "src/lib/publishTeams.ts")));
    expect(core).not.toMatch(
      /teamsPostStatus|postedTeamGenerationId|telegramApi|telegramFormat|callTelegram|fetch\(|api\.telegram\.org|allowTelegramPollActions|PublishOptions/
    );
  });
});

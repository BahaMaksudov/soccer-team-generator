import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6D.5E.5 — post-deletion invariants for the retired legacy
 * Admin surface (supersedes the 5E.1 legacyPublishNeutralized checks,
 * whose subject files no longer exist).
 */

const root = path.resolve(__dirname, "../../..");
const rel = (...p: string[]) => path.join(...p);

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const productionFiles = [...walk("src"), "next.config.js"].filter((f) => fs.existsSync(path.join(root, f)));
const code = new Map(productionFiles.map((f) => [f, stripComments(fs.readFileSync(path.join(root, f), "utf8"))]));
const filesMatching = (re: RegExp) => [...code].filter(([, c]) => re.test(c)).map(([f]) => f).sort();

const DELETED_FLAT_ROUTES = [
  "players",
  "players/[id]",
  "generate",
  "publish",
  "settings/team-name",
  "settings/balance-weights",
  "telegram/chats",
  "telegram/polls",
  "telegram/users",
  "telegram/create-poll",
  "telegram/import",
  "telegram/link",
];

describe("flat operational Admin APIs are deleted", () => {
  it.each(DELETED_FLAT_ROUTES)("src/app/api/admin/%s/route.ts does not exist", (r) => {
    expect(fs.existsSync(path.join(root, "src/app/api/admin", r, "route.ts"))).toBe(false);
  });

  it("no production source references a deleted flat route URL", () => {
    const re = new RegExp(
      `["'\`]/api/admin/(${DELETED_FLAT_ROUTES.map((r) => r.replace(/[[\]/-]/g, "\\$&").replace("\\[id\\]", "")).join("|")})`
    );
    expect(filesMatching(re)).toEqual([]);
  });

  it("the remaining /api/admin/** routes are exactly the canonical set plus the 2D.6D.6 diagnostic", () => {
    const routes = walk("src/app/api/admin").filter((f) => f.endsWith("route.ts")).sort();
    const canonical = (p: string) => rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]", p, "route.ts");
    expect(routes).toEqual(
      [
        canonical("generate"),
        canonical("players"),
        canonical("players/[id]"),
        canonical("publish"),
        canonical("settings/balance-weights"),
        canonical("settings/team-name"),
        canonical("telegram/chats"),
        canonical("telegram/close-and-post"),
        canonical("telegram/create-poll"),
        canonical("telegram/import"),
        canonical("telegram/link"),
        canonical("telegram/polls"),
        canonical("telegram/users"),
        rel("src/app/api/admin/tenant-context/route.ts"),
      ].sort()
    );
  });

  it("every canonical route resolves tenancy from URL slugs, never the flat resolver", () => {
    for (const f of walk("src/app/api/admin/o").filter((x) => x.endsWith("route.ts"))) {
      expect(code.get(f), f).toContain("requireTenantContextForSlugs(");
      expect(code.get(f), f).not.toMatch(/requireTenantContext\(\)/);
    }
  });
});

describe("legacy Admin components and switches are gone from production code", () => {
  it("no production code mentions a deleted legacy component or the retired Telegram switch", () => {
    expect(
      filesMatching(
        /\b(AdminWorkspace|PlayerSelection|GenerationControls|TeamSettings|DeletePublishedTeams|TelegramPollImport|TelegramUserLinks|allowTelegramPollActions|PublishOptions)\b/
      )
    ).toEqual([]);
  });

  it("removed legacy-only helpers are not exported or used", () => {
    expect(filesMatching(/\b(tenantErrorResponse|revalidateLegacyTeamNamePages|revalidateLegacyBalanceWeightsPages)\b/)).toEqual([]);
  });
});

describe("Telegram delivery invariant", () => {
  it("publishTeamsForContext is called only by the canonical Publish route", () => {
    const callers = filesMatching(/publishTeamsForContext\(/).filter((f) => f !== rel("src/lib/publishTeams.ts"));
    expect(callers).toEqual([rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route.ts")]);
  });

  it("Publish core is DB-only: no Telegram client, formatter, or fetch", () => {
    expect(code.get(rel("src/lib/publishTeams.ts"))).not.toMatch(
      /telegram(Api|Format|CloseAndPost)|callTelegram|fetch\(|sendMessage|stopPoll|teamsPostStatus/
    );
  });

  it("only telegramCloseAndPost.ts formats teams for Telegram, stops polls, or touches posting state", () => {
    expect(filesMatching(/formatTeamsHtml\(/).filter((f) => f !== rel("src/lib/telegramFormat.ts"))).toEqual([
      rel("src/lib/telegramCloseAndPost.ts"),
    ]);
    expect(filesMatching(/["']stopPoll["']/)).toEqual([rel("src/lib/telegramCloseAndPost.ts")]);
    expect(filesMatching(/teamsPostStatus/)).toEqual([rel("src/lib/telegramCloseAndPost.ts")]);
  });

  it("sendMessage is used only by Close/Post (teams) and the webhook (bot command replies)", () => {
    expect(filesMatching(/["']sendMessage["']/)).toEqual(
      [rel("src/app/api/telegram/webhook/route.ts"), rel("src/lib/telegramCloseAndPost.ts")].sort()
    );
    const webhook = code.get(rel("src/app/api/telegram/webhook/route.ts"))!;
    expect(webhook).not.toMatch(/formatTeamsHtml|teamsJson|teamGeneration/);
  });

  it("the only Admin route that reaches the Close/Post core is canonical telegram/close-and-post", () => {
    expect(filesMatching(/closePollAndPostTeamsForContext\(/).filter((f) => !f.endsWith("telegramCloseAndPost.ts"))).toEqual([
      rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route.ts"),
    ]);
  });
});

describe("webhook independence", () => {
  const webhook = code.get(rel("src/app/api/telegram/webhook/route.ts"))!;

  it("imports only next/server, prisma, and dateOnly", () => {
    expect([...webhook.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]).sort()).toEqual(
      ["@/lib/dateOnly", "@/lib/prisma", "next/server"].sort()
    );
  });

  it("never uses the Admin tenant resolvers or Admin APIs", () => {
    expect(webhook).not.toMatch(/requireTenantContext|\/api\/admin|admin\/components|legacy-workspace/);
  });

  it("resolves tenancy from persisted TelegramChat/TelegramPoll ownership", () => {
    expect(webhook).toMatch(/telegramChat\.findUnique\(\{\s*where: \{ chatId \}/);
    expect(webhook).toMatch(/telegramPoll\.findUnique\(/);
  });
});

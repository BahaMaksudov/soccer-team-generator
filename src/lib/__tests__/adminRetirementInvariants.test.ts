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
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.i?test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const productionFiles = [...walk("src"), "next.config.js"].filter((f) => fs.existsSync(path.join(root, f)));
const code = new Map(productionFiles.map((f) => [f, stripComments(fs.readFileSync(path.join(root, f), "utf8"))]));
const filesMatching = (re: RegExp) => [...code].filter(([, c]) => re.test(c)).map(([f]) => f).sort();

// M5 — the only /api/admin routes outside o/[org]/g/[group]: account-level
// (the session User creates their own Organization) and Organization-level
// (OWNER members/invitations, URL-bound via requireOrganizationContextForSlug).
const M5_ACCOUNT_ROUTE = rel("src/app/api/admin/organizations/route.ts");
const M5_ORGANIZATION_ROUTES = [
  rel("src/app/api/admin/o/[organizationSlug]/invitations/route.ts"),
  rel("src/app/api/admin/o/[organizationSlug]/groups/route.ts"), // M7: Add Group (OWNER/ADMIN)
  // M11.2A — Organization billing (OWNER; ADMIN read-only status).
  rel("src/app/api/admin/o/[organizationSlug]/billing/route.ts"),
  rel("src/app/api/admin/o/[organizationSlug]/billing/checkout/route.ts"),
  rel("src/app/api/admin/o/[organizationSlug]/billing/portal/route.ts"),
];
const M5_NON_GROUP_ROUTES = [M5_ACCOUNT_ROUTE, ...M5_ORGANIZATION_ROUTES];

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

  it("the remaining /api/admin/** routes are exactly the canonical URL-bound set (Phase 2D.6D.6: no flat route at all)", () => {
    const routes = walk("src/app/api/admin").filter((f) => f.endsWith("route.ts")).sort();
    const canonical = (p: string) => rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]", p, "route.ts");
    expect(routes).toEqual(
      [
        canonical("generate"),
        canonical("generate/swap"), // M8-A: Apply Swap (preview only)
        canonical("matches"), // M9-A
        canonical("matches/[matchId]"),
        canonical("matches/[matchId]/attendance"),
        canonical("matches/[matchId]/attendance/close"),
        canonical("matches/[matchId]/attendance/sync"),
        canonical("matches/[matchId]/poll"),
        canonical("matches/[matchId]/poll/close"), // M9.2
        canonical("channels/telegram"),
        canonical("channels/telegram/[ref]"),
        canonical("channels/telegram/[ref]/players"), // M9-B
        canonical("channels/telegram/[ref]/community"), // M9.2
        canonical("communities"), // M9.2
        canonical("communities/[communityId]"), // M9.2
        canonical("communities/[communityId]/players"), // M9.2
        canonical("venues"), // M9.2
        canonical("schedules"), // M9.2
        canonical("schedules/[scheduleId]"), // M9.2
        canonical("schedules/[scheduleId]/run"), // M9.2.1 — organizer Run Now
        canonical("schedules/[scheduleId]/keep"), // M11.1 — keep one schedule active (plan limit)
        canonical("matches/[matchId]/automation"), // M9.2
        canonical("matches/[matchId]/share"), // M9.3 — Match Link (organizer)
        canonical("matches/[matchId]/share/reset"), // M9.3
        canonical("venues/[venueId]"), // M9.2
        canonical("matches/[matchId]/telegram-chat"), // M9-B
        canonical("matches/[matchId]/post-game"), // M9-D
        canonical("players"),
        canonical("players/[id]"),
        canonical("players/[id]/claim"), // M6-C
        canonical("players/[id]/account"), // M6-C
        canonical("players/[id]/telegram"), // M6.1
        canonical("publish"),
        canonical("settings/balance-weights"),
        canonical("settings/team-name"),
        canonical("settings/visibility"), // M6-A
        canonical("share-link"), // M6-A
        canonical("telegram/chats"),
        canonical("telegram/close-and-post"),
        canonical("telegram/create-poll"),
        canonical("telegram/delivery"), // M6-B
        canonical("telegram/import"),
        canonical("telegram/link"),
        canonical("telegram/polls"),
        canonical("telegram/users"),
        ...M5_NON_GROUP_ROUTES,
      ].sort()
    );
  });

  it("every /api/admin route file lives under o/[organizationSlug]/g/[groupSlug]/ (except the listed M5 routes)", () => {
    const routes = walk("src/app/api/admin").filter((f) => f.endsWith("route.ts") && !M5_NON_GROUP_ROUTES.includes(f));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) {
      expect(f.startsWith(rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/")), f).toBe(true);
    }
  });

  it("/api/admin/tenant-context no longer exists", () => {
    expect(fs.existsSync(path.join(root, "src/app/api/admin/tenant-context"))).toBe(false);
    expect(filesMatching(/["'`]\/api\/admin\/tenant-context/)).toEqual([]);
  });

  it("every canonical route resolves tenancy from URL slugs, never the flat resolver", () => {
    for (const f of walk("src/app/api/admin/o").filter((x) => x.endsWith("route.ts") && !M5_ORGANIZATION_ROUTES.includes(x))) {
      expect(code.get(f), f).toContain("requireTenantContextForSlugs(");
      expect(code.get(f), f).not.toMatch(/requireTenantContext\(\)/);
    }
  });

  it("M5 Organization-level routes resolve the Organization from the URL slug + membership; the account route only from the session User", () => {
    for (const f of M5_ORGANIZATION_ROUTES) {
      expect(code.get(f), f).toContain("requireOrganizationContextForSlug(");
    }
    expect(code.get(M5_ACCOUNT_ROUTE)).toContain("requireSessionUser()");
    expect(code.get(M5_ACCOUNT_ROUTE)).toContain("createOrganizationWorkspace(user.id,");
  });
});

describe("single-tenant resolver is gone (Phase 2D.6D.6)", () => {
  // Word-boundary + negative lookahead so requireTenantContextForSlugs
  // never counts as a match.
  const FLAT_RESOLVER = /\brequireTenantContext(?!ForSlugs)\b|\bresolveTenantContextForEmail\b|\btenantContextErrorStatus\b/;

  it("the pattern distinguishes the removed resolver from requireTenantContextForSlugs", () => {
    expect(FLAT_RESOLVER.test("await requireTenantContext()")).toBe(true);
    expect(FLAT_RESOLVER.test("export async function requireTenantContext(): Promise")).toBe(true);
    expect(FLAT_RESOLVER.test("await requireTenantContextForSlugs({ organizationSlug, groupSlug })")).toBe(false);
  });

  it("production source contains zero definitions or calls of the single-tenant resolver", () => {
    expect(filesMatching(FLAT_RESOLVER)).toEqual([]);
  });

  it("the exactly-one-Organization/Group ambiguity codes no longer exist", () => {
    expect(filesMatching(/MULTIPLE_(ORGANIZATIONS|GROUPS)_REQUIRE_SELECTION/)).toEqual([]);
  });

  it("Admin tenancy comes only from the URL-bound resolver or the /admin accessible-tenant listing", () => {
    const tenantEntry = filesMatching(/\b(requireTenantContextForSlugs|listAccessibleTenants)\(/).filter(
      (f) => f !== rel("src/lib/tenantContext.ts")
    );
    const listing = tenantEntry.filter((f) => /\blistAccessibleTenants\(/.test(code.get(f)!));
    // M5: /onboarding uses the listing only to count the User's own Organizations.
    // UI-6: Account lists the session User's OWN memberships/roles (display only, links to URL-bound pages).
    expect(listing.sort()).toEqual([rel("src/app/account/security/page.tsx"), rel("src/app/admin/page.tsx"), rel("src/app/onboarding/page.tsx")].sort());
    for (const f of tenantEntry.filter((x) => !listing.includes(x))) {
      expect(f.startsWith(rel("src/app/api/admin/o/")) || f.startsWith(rel("src/app/admin/o/")), f).toBe(true);
    }
  });

  it("no Admin route or shared core reads groupId/organizationId from the request", () => {
    const cores = ["playerCrud", "generateTeams", "publishTeams", "groupSettings", "telegramAdmin", "telegramCloseAndPost"].map(
      (n) => rel("src/lib", `${n}.ts`)
    );
    const files = [...walk("src/app/api/admin").filter((f) => f.endsWith("route.ts")), ...cores];
    for (const f of files) {
      expect(code.get(f), f).not.toMatch(/(body|parsed\.data|searchParams)[^;\n]*\b(groupId|organizationId)\b/);
      for (const m of code.get(f)!.matchAll(/\bgroupId: ([A-Za-z_.]+)/g)) {
        expect(["activeGroupId", "context.activeGroup.id"], `${f}: groupId: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});

describe("/admin entry never assumes a single Group", () => {
  const entry = code.get(rel("src/app/admin/adminEntry.ts"))!;

  it("redirects only for exactly one Organization with exactly one active Group; otherwise selects", () => {
    expect(entry).toMatch(/organizations\.length === 0[\s\S]*no-access/);
    expect(entry).toMatch(/organizations\.length > 1[\s\S]*kind: "select"/);
    expect(entry).toMatch(/organization\.groups\.length > 1[\s\S]*kind: "select"/);
  });

  it("links and redirects are built only from resolved slugs — no cookies, storage, or env defaults", () => {
    const page = code.get(rel("src/app/admin/page.tsx"))!;
    for (const src of [entry, page]) {
      expect(src).not.toMatch(/cookies\(|localStorage|sessionStorage|DEFAULT_PUBLIC|getDefaultPublicGroupSlugs|process\.env/);
    }
    expect(page).toContain("`/admin/o/${encodeURIComponent(org.slug)}/g/${encodeURIComponent(g.slug)}`");
    expect(entry).toContain("`/admin/o/${encodeURIComponent(organization.slug)}/g/${encodeURIComponent(group.slug)}`");
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
    // M9-D — closing a Match's MVP vote also stops its Telegram poll (an explicit OWNER/ADMIN action).
    // M9.2 — publishing a Match's teams (and the attendance cutoff) closes its attendance poll.
    expect(filesMatching(/["']stopPoll["']/)).toEqual([rel("src/lib/matchPollClose.ts"), rel("src/lib/postGame.ts"), rel("src/lib/telegramCloseAndPost.ts")].sort());
    expect(filesMatching(/teamsPostStatus/)).toEqual([rel("src/lib/telegramCloseAndPost.ts")]);
  });

  it("sendMessage is used only by Close/Post (teams), the explicit post-game posts (M9-D) and the webhook (bot command replies)", () => {
    expect(filesMatching(/["']sendMessage["']/)).toEqual(
      [rel("src/app/api/telegram/webhook/route.ts"), rel("src/lib/postGame.ts"), rel("src/lib/telegramCloseAndPost.ts")].sort()
    );
    // M9-D — in postGame.ts the only sendMessage is the explicit "post_message" action.
    const postGame = code.get(rel("src/lib/postGame.ts"))!;
    expect(postGame.match(/["']sendMessage["']/g)).toHaveLength(1);
    expect(postGame.slice(postGame.indexOf('case "post_message"'))).toContain('"sendMessage"');
    const webhook = code.get(rel("src/app/api/telegram/webhook/route.ts"))!;
    expect(webhook).not.toMatch(/formatTeamsHtml|teamsJson|teamGeneration/);
  });

  it("the only Admin route that reaches the Close/Post core is canonical telegram/close-and-post", () => {
    expect(filesMatching(/closePollAndPostTeamsForContext\(/).filter((f) => !f.endsWith("telegramCloseAndPost.ts"))).toEqual([
      rel("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route.ts"),
    ]);
  });
});

describe("tenant-isolation hardening invariants (Phase 2D.6E.6C)", () => {
  const crud = () => code.get(rel("src/lib/playerCrud.ts"))!;

  it("Player PATCH/DELETE mutate only through id+groupId-scoped updateMany/deleteMany — never by id alone", () => {
    // M11.1 — the update runs inside the capacity-check transaction (tx); still id+groupId-scoped.
    expect(crud()).not.toMatch(/(prisma|tx)\.player\.(update|delete)\(/);
    expect(crud()).toMatch(/(prisma|tx)\.player\.updateMany\(\{ where: \{ id, groupId \}/);
    expect(crud()).toMatch(/prisma\.player\.deleteMany\(\{ where: \{ id, groupId: context\.activeGroup\.id \} \}\)/);
  });

  it("Player CRUD never returns a raw error message to the client", () => {
    expect(crud()).not.toMatch(/error: message/);
  });

  it("the Telegram link refusal never says a user is linked elsewhere", () => {
    expect(filesMatching(/linked elsewhere/)).toEqual([]);
  });

  it("Publish validates submitted players against the active Group before the upsert", () => {
    const core = code.get(rel("src/lib/publishTeams.ts"))!;
    const check = core.indexOf("prisma.player.findMany(");
    const upsert = core.indexOf("prisma.teamGeneration.upsert(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(upsert);
    expect(core).toContain("where: { groupId: activeGroupId, id: { in: playerIds } }");
  });

  it("Publish persists only the server-built snapshot, never the request's teams (Phase 2D.6E.6D)", () => {
    const core = code.get(rel("src/lib/publishTeams.ts"))!;
    expect(core).not.toMatch(/teamsJson: JSON\.stringify\(teams\)/);
    // M9-B — one serialization of the server-built snapshot, used by every write path.
    expect(core.match(/JSON\.stringify\(snapshotTeams\)/g)).toHaveLength(1);
    expect(core).toContain("const teamsJson = JSON.stringify(snapshotTeams);");
    expect(core.indexOf("buildPublishSnapshot(teams, owned)")).toBeLessThan(core.indexOf("prisma.teamGeneration.upsert("));
  });
});

describe("webhook independence", () => {
  const webhook = code.get(rel("src/app/api/telegram/webhook/route.ts"))!;

  it("imports only next/server, prisma, dateOnly, the connect-code service and (M9-A) the attendance/channel adapters", () => {
    expect([...webhook.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]).sort()).toEqual(
      ["@/lib/dateOnly", "@/lib/prisma", "@/lib/telegramConnect", "@/lib/telegramAttendance", "@/lib/telegramChannels", "@/lib/telegramMvp", "next/server"].sort()
    );
  });

  it("M6-C: the retired /link command never writes a Player or the legacy telegramUserId column", () => {
    const link = webhook.slice(webhook.indexOf('cmd === "/link"'), webhook.indexOf("async function handlePollAnswer"));
    expect(link).not.toMatch(/prisma\.|telegramUserId|player\.update/);
  });

  it("never uses the Admin tenant resolvers or Admin APIs", () => {
    expect(webhook).not.toMatch(/requireTenantContext|listAccessibleTenants|\/api\/admin|admin\/components|legacy-workspace/);
  });

  it("resolves tenancy from persisted TelegramPoll ownership; chats are bound only via a verified bind code (M9-A)", () => {
    expect(webhook).toMatch(/telegramPoll\.findUnique\(/);
    expect(webhook).toContain("redeemTelegramBindCode(");
    // The webhook itself never creates/updates a TelegramChat row or a TelegramPoll (/poll is retired).
    expect(webhook).not.toMatch(/telegramChat\.(create|upsert|update)|telegramPoll\.(create|upsert)/);
  });
});

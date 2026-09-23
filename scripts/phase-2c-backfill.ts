/**
 * PHASE 2C.2 — controlled, one-time production tenant backfill.
 *
 * Creates the initial Organization/Group/User/OrganizationMembership/
 * GroupSetting records and assigns the existing single-tenant legacy
 * data (Player, TeamGeneration, TelegramChat, TelegramPoll,
 * TelegramPollAnswer, TelegramUserLink) to that Group via `groupId`.
 *
 * This is a one-time migration script. It is not application code —
 * do not import it from anything under src/.
 *
 * Usage:
 *   npx tsx scripts/phase-2c-backfill.ts            → DRY RUN (default). Zero writes.
 *   npx tsx scripts/phase-2c-backfill.ts --execute   → Actually writes. Only proceeds
 *                                                       if the pre-flight state is
 *                                                       exactly NOT_STARTED.
 *
 * State machine (see report for full definitions):
 *   NOT_STARTED       → dry run: print plan and stop. execute: run the transaction.
 *   ALREADY_COMPLETED → validate existing result, make ZERO writes, exit successfully.
 *   PARTIALLY_APPLIED → STOP, make ZERO writes, report for human review.
 *   UNSAFE_STATE      → STOP, make ZERO writes, report for human review.
 * This script NEVER auto-resumes or auto-repairs PARTIALLY_APPLIED or
 * UNSAFE_STATE — those always require a human decision.
 */

import fs from "node:fs";
import path from "node:path";

// ---- manual .env loading (no dotenv dependency in this project) ----
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const rawLine of envContent.split("\n")) {
    const m = rawLine.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

import { PrismaClient, OrgRole } from "@prisma/client";

const prisma = new PrismaClient();

// ---------------------------------------------------------------
// Approved Phase 2C.2 product-owner decisions (hardcoded constants,
// not read from any external input — this script's whole purpose is
// this one specific, one-time migration).
// ---------------------------------------------------------------
const ORG_NAME = "New England Eagles";
const ORG_SLUG = "new-england-eagles";

const GROUP_NAME = "Indoor Soccer";
const GROUP_SLUG = "indoor-soccer";
const GROUP_SPORT_KEY = "soccer";
const GROUP_TIMEZONE = "America/New_York";

const OWNER_NAME = "Bahrom Maksudov";

const TEAM_NAME_SETTING_KEY = "teamName";
const EXPECTED_TEAM_NAME_VALUE = "New England Eagles";
const EXCLUDED_APPSETTING_KEY = "TEAM_NAME"; // must NOT be copied

const LEGACY_TABLES = [
  "Player",
  "TeamGeneration",
  "TelegramChat",
  "TelegramPoll",
  "TelegramPollAnswer",
  "TelegramUserLink",
] as const;
type LegacyTable = (typeof LEGACY_TABLES)[number];

const EXECUTE = process.argv.includes("--execute");

function section(title: string) {
  console.log(`\n${"=".repeat(3)} ${title} ${"=".repeat(Math.max(0, 74 - title.length))}`);
}
function jout(v: unknown) {
  console.log(JSON.stringify(v, (_, val) => (typeof val === "bigint" ? val.toString() : val), 2));
}
function stop(reason: string): never {
  console.log(`\n🛑 STOP — no writes made.\nReason: ${reason}\n`);
  console.log("NOT READY — see reason above.");
  process.exitCode = 1;
  throw new Error(reason);
}

async function legacyDelegate(table: LegacyTable) {
  switch (table) {
    case "Player": return prisma.player;
    case "TeamGeneration": return prisma.teamGeneration;
    case "TelegramChat": return prisma.telegramChat;
    case "TelegramPoll": return prisma.telegramPoll;
    case "TelegramPollAnswer": return prisma.telegramPollAnswer;
    case "TelegramUserLink": return prisma.telegramUserLink;
  }
}

async function main() {
  console.log(
    EXECUTE
      ? "🔴 EXECUTE MODE requested — writes will occur ONLY if state is exactly NOT_STARTED."
      : "🟢 DRY RUN — read-only, this run makes ZERO database writes regardless of outcome."
  );

  // ================= A. Baseline =================
  section("A. Baseline");
  jout({ note: "See surrounding report for git branch/status/commit/migrate-status — captured by the operator, not this script." });

  // ================= B. Database target =================
  section("B. Database target (safely redacted)");
  const dbUrl = process.env.DATABASE_URL ?? "";
  const hostMatch = dbUrl.match(/@([^/?]+)/);
  const dbNameMatch = dbUrl.match(/\/([a-zA-Z0-9_-]+)(\?|$)/);
  const host = hostMatch ? hostMatch[1] : "unknown";
  const redactedHost = host.length > 10 ? `${host.slice(0, 8)}***${host.slice(-14)}` : "***";
  jout({ databaseName: dbNameMatch ? dbNameMatch[1] : "unknown", hostIdentifier: redactedHost });

  // ================= Env presence (no values) =================
  section("Environment presence (values never printed)");
  const adminEmailRaw = process.env.ADMIN_EMAIL;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  jout({ ADMIN_EMAIL_present: !!adminEmailRaw, ADMIN_PASSWORD_HASH_present: !!adminPasswordHash });
  if (!adminEmailRaw) stop("ADMIN_EMAIL is missing from the environment.");
  if (!adminPasswordHash) stop("ADMIN_PASSWORD_HASH is missing from the environment.");
  const adminEmail = adminEmailRaw.trim().toLowerCase();

  // ================= C. Current row counts (re-queried now) =================
  section("C. Current row counts (re-queried now, not trusted from any prior report)");
  const counts = {
    Player: await prisma.player.count(),
    TeamGeneration: await prisma.teamGeneration.count(),
    AppSetting: await prisma.appSetting.count(),
    TelegramChat: await prisma.telegramChat.count(),
    TelegramPoll: await prisma.telegramPoll.count(),
    TelegramPollAnswer: await prisma.telegramPollAnswer.count(),
    TelegramUserLink: await prisma.telegramUserLink.count(),
    User: await prisma.user.count(),
    Organization: await prisma.organization.count(),
    OrganizationMembership: await prisma.organizationMembership.count(),
    Group: await prisma.group.count(),
    GroupSetting: await prisma.groupSetting.count(),
  };
  jout(counts);

  // ================= D. groupId ownership (re-queried now) =================
  section("D. groupId ownership (re-queried now)");
  const ownership: Record<LegacyTable, { total: number; groupIdNull: number; groupIdNotNull: number }> = {} as any;
  for (const table of LEGACY_TABLES) {
    const delegate: any = await legacyDelegate(table);
    const total = await delegate.count();
    const nullCount = await delegate.count({ where: { groupId: null } });
    ownership[table] = { total, groupIdNull: nullCount, groupIdNotNull: total - nullCount };
  }
  jout(ownership);

  // ================= E. Telegram identity integrity (re-queried now) =================
  section("E. Telegram identity integrity (re-queried now)");
  const players = await prisma.player.findMany({
    select: { id: true, firstName: true, lastName: true, telegramUserId: true, groupId: true },
  });
  const links = await prisma.telegramUserLink.findMany({
    select: { id: true, userId: true, playerId: true, groupId: true },
  });
  const playerById = new Map(players.map((p) => [p.id, p]));
  const linkByPlayerId = new Map(links.map((l) => [l.playerId, l]));
  const linkByUserId = new Map(links.map((l) => [l.userId.toString(), l]));

  let matchCount = 0, playerOnlyCount = 0, linkOnlyCount = 0, conflictCount = 0, orphanCount = 0;
  const handledLinkIds = new Set<string>();
  for (const p of players) {
    if (p.telegramUserId == null) continue;
    const tgId = p.telegramUserId.toString();
    const linkForPlayer = linkByPlayerId.get(p.id);
    if (linkForPlayer) {
      handledLinkIds.add(linkForPlayer.id);
      linkForPlayer.userId.toString() === tgId ? matchCount++ : conflictCount++;
      continue;
    }
    const linkForTgId = linkByUserId.get(tgId);
    if (linkForTgId) {
      handledLinkIds.add(linkForTgId.id);
      conflictCount++;
      continue;
    }
    playerOnlyCount++;
  }
  for (const l of links) {
    if (handledLinkIds.has(l.id)) continue;
    if (!playerById.has(l.playerId)) { orphanCount++; continue; }
    linkOnlyCount++;
  }
  const identity = { MATCH: matchCount, PLAYER_ONLY: playerOnlyCount, LINK_ONLY: linkOnlyCount, CONFLICT: conflictCount, ORPHAN: orphanCount };
  jout(identity);
  if (conflictCount > 0) stop(`Telegram identity CONFLICT count is ${conflictCount}, expected 0.`);
  if (orphanCount > 0) stop(`Telegram identity ORPHAN count is ${orphanCount}, expected 0.`);

  // ================= F. AppSetting snapshot =================
  section("F. AppSetting snapshot (captured now; must be unchanged after any future write)");
  const settingsBefore = await prisma.appSetting.findMany({ select: { key: true, value: true, updatedAt: true } });
  jout(settingsBefore.map((s) => ({ key: s.key, value: s.value, updatedAt: s.updatedAt.toISOString() })));
  const teamNameSetting = settingsBefore.find((s) => s.key === TEAM_NAME_SETTING_KEY);
  if (!teamNameSetting) stop(`AppSetting "${TEAM_NAME_SETTING_KEY}" is missing.`);
  if (teamNameSetting.value !== EXPECTED_TEAM_NAME_VALUE) {
    stop(`AppSetting "${TEAM_NAME_SETTING_KEY}" value is "${teamNameSetting.value}", expected "${EXPECTED_TEAM_NAME_VALUE}".`);
  }
  const excludedSetting = settingsBefore.find((s) => s.key === EXCLUDED_APPSETTING_KEY);
  jout({
    note: `"${EXCLUDED_APPSETTING_KEY}" is intentionally NOT copied to GroupSetting.`,
    excludedKeyPresent: !!excludedSetting,
    excludedKeyValue: excludedSetting?.value ?? null,
  });

  // ================= G. State classification =================
  section("G. State classification");
  const existingOrg = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
  if (existingOrg && existingOrg.name !== ORG_NAME) {
    stop(`Organization slug "${ORG_SLUG}" already exists but with name "${existingOrg.name}", not "${ORG_NAME}". Unexpected entity owns this slug.`);
  }
  if (counts.Organization > 1) {
    stop(`Organization.count() = ${counts.Organization}, expected 0 or 1. Multiple organizations already exist — unexpected.`);
  }

  const existingGroup = existingOrg
    ? await prisma.group.findFirst({ where: { organizationId: existingOrg.id, slug: GROUP_SLUG } })
    : null;
  if (existingGroup) {
    const mismatches: string[] = [];
    if (existingGroup.name !== GROUP_NAME) mismatches.push(`name "${existingGroup.name}" != "${GROUP_NAME}"`);
    if (existingGroup.sportKey !== GROUP_SPORT_KEY) mismatches.push(`sportKey "${existingGroup.sportKey}" != "${GROUP_SPORT_KEY}"`);
    if (existingGroup.timezone !== GROUP_TIMEZONE) mismatches.push(`timezone "${existingGroup.timezone}" != "${GROUP_TIMEZONE}"`);
    if (mismatches.length) stop(`Group "${GROUP_SLUG}" exists but doesn't match approved values: ${mismatches.join("; ")}`);
  }
  if (counts.Group > 1) {
    stop(`Group.count() = ${counts.Group}, expected 0 or 1. Multiple groups already exist — unexpected/ambiguous.`);
  }
  if (existingOrg && counts.Group > 0 && !existingGroup) {
    stop(`A Group exists but not one matching slug "${GROUP_SLUG}" under organization "${ORG_SLUG}" — ambiguous.`);
  }

  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  const existingMembership =
    existingOrg && existingUser
      ? await prisma.organizationMembership.findUnique({
          where: { userId_organizationId: { userId: existingUser.id, organizationId: existingOrg.id } },
        })
      : null;
  const existingGroupSetting = existingGroup
    ? await prisma.groupSetting.findUnique({
        where: { groupId_key: { groupId: existingGroup.id, key: TEAM_NAME_SETTING_KEY } },
      })
    : null;

  // Any legacy row already pointing at a DIFFERENT group than our target
  // (or any non-null groupId at all, if our target Group doesn't exist yet)
  // is always unsafe.
  const foreignOwnership: Record<string, number> = {};
  for (const table of LEGACY_TABLES) {
    const delegate: any = await legacyDelegate(table);
    const notNullCount = ownership[table].groupIdNotNull;
    if (notNullCount === 0) { foreignOwnership[table] = 0; continue; }
    const foreignCount = existingGroup
      ? await delegate.count({ where: { groupId: { not: null, notIn: [existingGroup.id] } } })
      : notNullCount; // target group doesn't exist yet, so ANY non-null groupId is foreign
    foreignOwnership[table] = foreignCount;
  }
  const anyForeignOwnership = Object.values(foreignOwnership).some((c) => c > 0);
  if (anyForeignOwnership) {
    jout({ foreignOwnershipByTable: foreignOwnership });
    stop("At least one legacy row's groupId points to a group OTHER than the approved Indoor Soccer group (or a group doesn't exist yet but rows are already owned). Unexpected — requires human review.");
  }

  const allPiecesPresent = !!(existingOrg && existingGroup && existingUser && existingMembership && existingGroupSetting);
  const noPiecesPresent = !existingOrg && !existingGroup && !existingUser && !existingMembership && !existingGroupSetting;
  const allLegacyNull = LEGACY_TABLES.every((t) => ownership[t].groupIdNull === ownership[t].total);
  const allLegacyOwnedByTarget =
    existingGroup && LEGACY_TABLES.every((t) => ownership[t].groupIdNull === 0 && foreignOwnership[t] === 0);

  let state: "NOT_STARTED" | "ALREADY_COMPLETED" | "PARTIALLY_APPLIED" | "UNSAFE_STATE";
  if (noPiecesPresent && allLegacyNull) {
    state = "NOT_STARTED";
  } else if (allPiecesPresent && allLegacyOwnedByTarget) {
    state = "ALREADY_COMPLETED";
  } else if (noPiecesPresent && !allLegacyNull) {
    // structural pieces absent but some legacy rows already owned — contradictory/unsafe
    state = "UNSAFE_STATE";
  } else {
    state = "PARTIALLY_APPLIED";
  }

  jout({
    state,
    existingOrgFound: !!existingOrg,
    existingGroupFound: !!existingGroup,
    existingUserFound: !!existingUser,
    existingMembershipFound: !!existingMembership,
    existingGroupSettingFound: !!existingGroupSetting,
    allLegacyNull,
    allLegacyOwnedByTarget: !!allLegacyOwnedByTarget,
  });

  // ================= H. Planned records / updates =================
  section("H. Planned new records (dry-run preview — not created)");
  jout({
    Organization: { name: ORG_NAME, slug: ORG_SLUG },
    Group: { name: GROUP_NAME, slug: GROUP_SLUG, sportKey: GROUP_SPORT_KEY, timezone: GROUP_TIMEZONE, organization: ORG_SLUG },
    User: { email: adminEmail, name: OWNER_NAME, passwordHash: "<reused from ADMIN_PASSWORD_HASH, not printed>" },
    OrganizationMembership: { role: "OWNER", user: adminEmail, organization: ORG_SLUG },
    GroupSetting: { group: GROUP_SLUG, key: TEAM_NAME_SETTING_KEY, value: EXPECTED_TEAM_NAME_VALUE },
  });

  section("I. Planned legacy updates (expected affected row counts)");
  jout({
    Player: ownership.Player.groupIdNull,
    TeamGeneration: ownership.TeamGeneration.groupIdNull,
    TelegramChat: ownership.TelegramChat.groupIdNull,
    TelegramPoll: ownership.TelegramPoll.groupIdNull,
    TelegramPollAnswer: ownership.TelegramPollAnswer.groupIdNull,
    TelegramUserLink: ownership.TelegramUserLink.groupIdNull,
  });

  section("J. Data that will intentionally remain untouched");
  jout([
    "AppSetting (both rows, including the excluded TEAM_NAME key) — copy only, never modified",
    "Player.firstName/lastName/position/rating/stamina/isActive",
    "Player.telegramUserId/telegramUsername/telegramFirst/telegramLast — left exactly as-is (all NULL today)",
    "TeamGeneration.date and teamsJson — no historical rewrite",
    "TelegramChat.chatId/title",
    "TelegramPoll.pollId/chatId/messageId/question/optionsJson/pollDate/isClosed — including the one stale open poll, NOT closed",
    "TelegramPollAnswer vote data",
    "TelegramUserLink.userId/playerId",
    "No Telegram API calls of any kind",
  ]);

  // ================= K. Branch based on classification =================
  section("K. Outcome");

  if (state === "ALREADY_COMPLETED") {
    jout({ result: "ALREADY_COMPLETED — validated, zero writes made (this applies in both dry-run and --execute mode)." });
    console.log("\nREADY FOR PRODUCT-OWNER EXECUTION APPROVAL: N/A — already complete, nothing to execute.");
    return;
  }
  if (state === "PARTIALLY_APPLIED") {
    stop("State is PARTIALLY_APPLIED. This script never auto-resumes. Human review required before any further action.");
  }
  if (state === "UNSAFE_STATE") {
    stop("State is UNSAFE_STATE. Human review required before any further action.");
  }

  // state === NOT_STARTED from here on
  if (!EXECUTE) {
    console.log("\nDry run complete. No writes were made. Re-run with --execute (after explicit approval) to perform the backfill.");
    console.log("\nREADY FOR PRODUCT-OWNER EXECUTION APPROVAL");
    return;
  }

  // ================= EXECUTE: the actual transaction =================
  section("EXECUTING TRANSACTION");
  const txResult = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: ORG_NAME, slug: ORG_SLUG } });
    const group = await tx.group.create({
      data: {
        organizationId: org.id,
        name: GROUP_NAME,
        slug: GROUP_SLUG,
        sportKey: GROUP_SPORT_KEY,
        timezone: GROUP_TIMEZONE,
      },
    });
    const user = await tx.user.create({
      data: { email: adminEmail, name: OWNER_NAME, passwordHash: adminPasswordHash as string },
    });
    const membership = await tx.organizationMembership.create({
      data: { userId: user.id, organizationId: org.id, role: OrgRole.OWNER },
    });
    const groupSetting = await tx.groupSetting.create({
      data: { groupId: group.id, key: TEAM_NAME_SETTING_KEY, value: EXPECTED_TEAM_NAME_VALUE },
    });

    const playerUpd = await tx.player.updateMany({ where: { groupId: null }, data: { groupId: group.id } });
    const teamGenUpd = await tx.teamGeneration.updateMany({ where: { groupId: null }, data: { groupId: group.id } });
    const chatUpd = await tx.telegramChat.updateMany({ where: { groupId: null }, data: { groupId: group.id } });
    const pollUpd = await tx.telegramPoll.updateMany({ where: { groupId: null }, data: { groupId: group.id } });
    const answerUpd = await tx.telegramPollAnswer.updateMany({ where: { groupId: null }, data: { groupId: group.id } });
    const linkUpd = await tx.telegramUserLink.updateMany({ where: { groupId: null }, data: { groupId: group.id } });

    const expected = ownership;
    const mismatches: string[] = [];
    if (playerUpd.count !== expected.Player.groupIdNull) mismatches.push(`Player: expected ${expected.Player.groupIdNull}, got ${playerUpd.count}`);
    if (teamGenUpd.count !== expected.TeamGeneration.groupIdNull) mismatches.push(`TeamGeneration: expected ${expected.TeamGeneration.groupIdNull}, got ${teamGenUpd.count}`);
    if (chatUpd.count !== expected.TelegramChat.groupIdNull) mismatches.push(`TelegramChat: expected ${expected.TelegramChat.groupIdNull}, got ${chatUpd.count}`);
    if (pollUpd.count !== expected.TelegramPoll.groupIdNull) mismatches.push(`TelegramPoll: expected ${expected.TelegramPoll.groupIdNull}, got ${pollUpd.count}`);
    if (answerUpd.count !== expected.TelegramPollAnswer.groupIdNull) mismatches.push(`TelegramPollAnswer: expected ${expected.TelegramPollAnswer.groupIdNull}, got ${answerUpd.count}`);
    if (linkUpd.count !== expected.TelegramUserLink.groupIdNull) mismatches.push(`TelegramUserLink: expected ${expected.TelegramUserLink.groupIdNull}, got ${linkUpd.count}`);
    if (mismatches.length) throw new Error(`Affected-row-count mismatch, rolling back: ${mismatches.join("; ")}`);

    // Relational consistency validation, inside the transaction, before commit.
    const pollsAfter = await tx.telegramPoll.findMany({ select: { pollId: true, chatId: true, groupId: true } });
    const chatsAfter = await tx.telegramChat.findMany({ select: { chatId: true, groupId: true } });
    const chatGroupByChatId = new Map(chatsAfter.map((c) => [c.chatId.toString(), c.groupId]));
    for (const p of pollsAfter) {
      if (p.groupId !== chatGroupByChatId.get(p.chatId.toString())) {
        throw new Error(`Poll ${p.pollId} groupId does not match its chat's groupId — rolling back.`);
      }
    }
    const answersAfter = await tx.telegramPollAnswer.findMany({ select: { id: true, pollId: true, groupId: true } });
    const pollGroupByPollId = new Map(pollsAfter.map((p) => [p.pollId, p.groupId]));
    for (const a of answersAfter) {
      if (a.groupId !== pollGroupByPollId.get(a.pollId)) {
        throw new Error(`Answer ${a.id} groupId does not match its poll's groupId — rolling back.`);
      }
    }
    const linksAfter = await tx.telegramUserLink.findMany({ select: { id: true, playerId: true, groupId: true } });
    const playersAfter = await tx.player.findMany({ select: { id: true, groupId: true } });
    const playerGroupById = new Map(playersAfter.map((p) => [p.id, p.groupId]));
    for (const l of linksAfter) {
      const pg = playerGroupById.get(l.playerId);
      if (pg === undefined) throw new Error(`TelegramUserLink ${l.id} references missing Player ${l.playerId} — rolling back.`);
      if (pg !== l.groupId) throw new Error(`TelegramUserLink ${l.id} groupId does not match its Player's groupId — rolling back.`);
    }

    return {
      orgId: org.id, groupId: group.id, userId: user.id, membershipId: membership.id, groupSettingId: groupSetting.id,
      counts: { playerUpd: playerUpd.count, teamGenUpd: teamGenUpd.count, chatUpd: chatUpd.count, pollUpd: pollUpd.count, answerUpd: answerUpd.count, linkUpd: linkUpd.count },
    };
  });

  jout({ transactionResult: txResult });

  const settingsAfter = await prisma.appSetting.findMany({ select: { key: true, value: true } });
  const settingsChanged =
    JSON.stringify(settingsBefore.map((s) => [s.key, s.value]).sort()) !==
    JSON.stringify(settingsAfter.map((s) => [s.key, s.value]).sort());
  if (settingsChanged) {
    console.error("⚠️ WARNING: AppSetting rows changed during the transaction — this should be impossible and needs investigation.");
  } else {
    console.log("✅ AppSetting rows confirmed unchanged after transaction.");
  }

  console.log("\n✅ EXECUTION COMPLETE.");
}

main()
  .catch((e) => {
    console.error("\nScript ended with an error (see STOP reason above if present).");
    if (process.exitCode === undefined) process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

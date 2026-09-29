import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

// ---------------------------------------------------------------
// In-memory fake of the two tables this route touches. updateMany
// evaluates its `where` against the CURRENT row and applies `data` in
// one synchronous step — the same all-or-nothing, re-evaluate-on-write
// behavior a single Postgres UPDATE ... WHERE gives under concurrency.
// ---------------------------------------------------------------
type PollRow = {
  pollId: string;
  groupId: string | null;
  chatId: bigint;
  messageId: bigint | null;
  question: string;
  pollDate: Date | null;
  isClosed: boolean;
  teamsPostStatus: "SENDING" | "POSTED" | null;
  postedTeamGenerationId: string | null;
  teamsPostClaimedAt: Date | null;
  teamsPostedAt: Date | null;
};
type GenRow = { id: string; groupId: string | null; date: Date; teamsJson: string };

let polls: Map<string, PollRow>;
let gens: Map<string, GenRow>;

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}
function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

const pollFindFirst = vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
  const row = [...polls.values()].find((r) => matches(r, where));
  return row ? pick(row, select) : null;
});
const atomicUpdateMany = async ({ where, data }: { where: Record<string, unknown>; data: Partial<PollRow> }) => {
  let count = 0;
  for (const row of polls.values()) {
    if (matches(row, where)) {
      Object.assign(row, data);
      count++;
    }
  }
  return { count };
};
const pollUpdateMany = vi.fn(atomicUpdateMany);
const genFindFirst = vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
  const row = [...gens.values()].find((r) => matches(r, where));
  return row ? pick(row, select) : null;
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPoll: {
      findFirst: (...a: [never]) => pollFindFirst(...a),
      updateMany: (...a: [never]) => pollUpdateMany(...a),
    },
    teamGeneration: { findFirst: (...a: [never]) => genFindFirst(...a) },
  },
}));

import { POST } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

const DAY = new Date("2026-09-28T00:00:00.000Z");
const TEAMS = [
  { teamNumber: 1, players: [{ firstName: "Ann", lastName: "Alpha", id: "p1" }] },
  { teamNumber: 2, players: [{ firstName: "Bob", lastName: "Beta", id: "p2" }] },
];

function seed(overrides: { poll?: Partial<PollRow>; gen?: Partial<GenRow> } = {}) {
  polls = new Map();
  gens = new Map();
  const poll: PollRow = {
    pollId: "poll-1",
    groupId: "group-a",
    chatId: -100123n,
    messageId: 77n,
    question: "Who is playing on 9/28/26?",
    pollDate: DAY,
    isClosed: false,
    teamsPostStatus: null,
    postedTeamGenerationId: null,
    teamsPostClaimedAt: null,
    teamsPostedAt: null,
    ...overrides.poll,
  };
  const gen: GenRow = { id: "gen-1", groupId: "group-a", date: DAY, teamsJson: JSON.stringify(TEAMS), ...overrides.gen };
  polls.set(poll.pollId, poll);
  gens.set(gen.id, gen);
  // Foreign-Group resources that must never be reachable from group-a.
  polls.set("poll-b", { ...poll, pollId: "poll-b", groupId: "group-b", chatId: -100999n });
  gens.set("gen-b", { ...gen, id: "gen-b", groupId: "group-b" });
  return polls.get("poll-1")!;
}

function ctx() {
  return { params: Promise.resolve({ organizationSlug: "org-a", groupSlug: "group-a" }) };
}
function req(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}
const BODY = { pollId: "poll-1", teamGenerationId: "gen-1" };

type TgCall = { method: string; body: Record<string, unknown> };
let tgCalls: TgCall[];
let tgHandler: (method: string, body: Record<string, unknown>) => Promise<unknown>;

const originalFetch = global.fetch;

function okResponse(result: unknown = true) {
  return { json: async () => ({ ok: true, result }) };
}
function rejectResponse(description: string, error_code = 400) {
  return { json: async () => ({ ok: false, error_code, description }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  pollUpdateMany.mockImplementation(atomicUpdateMany);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
  tgCalls = [];
  tgHandler = async () => okResponse();
  // NEVER let a test reach the real Telegram API.
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    tgCalls.push({ method, body });
    return tgHandler(method, body);
  }) as unknown as typeof fetch;
  seed();
});

afterEach(() => {
  global.fetch = originalFetch;
});

const sends = () => tgCalls.filter((c) => c.method === "sendMessage");
const stops = () => tgCalls.filter((c) => c.method === "stopPoll");

describe("canonical close-and-post — success path", () => {
  it("closes the poll, posts teams once, and ends POSTED for this generation", async () => {
    const res = await POST(req(BODY), ctx());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, status: "posted", closeStatus: "closed_now", teamGenerationId: "gen-1" });
    expect(tgCalls.map((c) => c.method)).toEqual(["stopPoll", "sendMessage"]);
    expect(stops()[0].body).toEqual({ chat_id: "-100123", message_id: 77 });

    const row = polls.get("poll-1")!;
    expect(row.isClosed).toBe(true);
    expect(row.teamsPostStatus).toBe("POSTED");
    expect(row.postedTeamGenerationId).toBe("gen-1");
    expect(row.teamsPostClaimedAt).toBeInstanceOf(Date);
    expect(row.teamsPostedAt).toBeInstanceOf(Date);
  });

  it("resolves tenant via the URL slugs", async () => {
    await POST(req(BODY), ctx());
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("formats the message only from persisted teamsJson, ignoring any body-supplied teams", async () => {
    await POST(
      req({ ...BODY, teams: [{ teamNumber: 9, players: [{ firstName: "Evil", lastName: "Injected" }] }] }),
      ctx()
    );
    const text = String(sends()[0].body.text);
    expect(text).toContain("Ann Alpha");
    expect(text).toContain("Bob Beta");
    expect(text).toContain("9/28/26");
    expect(text).not.toContain("Evil");
    expect(sends()[0].body).toMatchObject({ chat_id: "-100123", parse_mode: "HTML" });
  });

  it("skips stopPoll when the poll is already closed locally", async () => {
    seed({ poll: { isClosed: true } });
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(data).toMatchObject({ status: "posted", closeStatus: "already_closed_locally" });
    expect(stops()).toHaveLength(0);
    expect(sends()).toHaveLength(1);
  });

  it("Telegram 'already been closed' persists isClosed=true and still posts", async () => {
    tgHandler = async (m) =>
      m === "stopPoll" ? rejectResponse("Bad Request: poll has already been closed") : okResponse();
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(data).toMatchObject({ status: "posted", closeStatus: "already_closed_on_telegram" });
    expect(polls.get("poll-1")!.isClosed).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  it("a close failure does not persist isClosed and does not block posting", async () => {
    tgHandler = async (m) => (m === "stopPoll" ? rejectResponse("Bad Request: message can't be edited") : okResponse());
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(data).toMatchObject({ status: "posted", closeStatus: "close_failed" });
    expect(polls.get("poll-1")!.isClosed).toBe(false);
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("POSTED");
  });
});

describe("canonical close-and-post — validation before any Telegram call or state write", () => {
  function expectNoSideEffects() {
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pollUpdateMany).not.toHaveBeenCalled();
  }

  it("invalid tenant fails before any lookup or external call", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(404);
    expect(pollFindFirst).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it("unauthenticated fails with 401 before any external call", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it("rejects a body missing teamGenerationId", async () => {
    const res = await POST(req({ pollId: "poll-1" }), ctx());
    expect(res.status).toBe(400);
    expectNoSideEffects();
  });

  it("a foreign Group's poll is rejected as not found", async () => {
    const res = await POST(req({ pollId: "poll-b", teamGenerationId: "gen-1" }), ctx());
    expect(res.status).toBe(404);
    expect(pollFindFirst.mock.calls[0][0].where).toEqual({ pollId: "poll-b", groupId: "group-a" });
    expectNoSideEffects();
    expect(polls.get("poll-b")!.teamsPostStatus).toBeNull();
  });

  it("a foreign Group's TeamGeneration is rejected as not found", async () => {
    const res = await POST(req({ pollId: "poll-1", teamGenerationId: "gen-b" }), ctx());
    expect(res.status).toBe(404);
    expect(genFindFirst.mock.calls[0][0].where).toEqual({ id: "gen-b", groupId: "group-a" });
    expectNoSideEffects();
  });

  it("missing poll and missing generation are rejected", async () => {
    expect((await POST(req({ pollId: "nope", teamGenerationId: "gen-1" }), ctx())).status).toBe(404);
    expect((await POST(req({ pollId: "poll-1", teamGenerationId: "nope" }), ctx())).status).toBe(404);
    expectNoSideEffects();
  });

  it("pollDate null is rejected (no question-text fallback)", async () => {
    seed({ poll: { pollDate: null } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(400);
    expectNoSideEffects();
  });

  it("poll/generation date mismatch is rejected", async () => {
    seed({ gen: { date: new Date("2026-09-29T00:00:00.000Z") } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(400);
    expectNoSideEffects();
  });

  it("same UTC calendar day with different time components still matches", async () => {
    seed({ poll: { pollDate: new Date("2026-09-28T00:00:00.000Z") }, gen: { date: new Date("2026-09-28T17:30:00.000Z") } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(200);
  });

  it("malformed persisted teamsJson (not JSON) is rejected before posting", async () => {
    seed({ gen: { teamsJson: "{not json" } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(422);
    expectNoSideEffects();
  });

  it("persisted teamsJson with the wrong shape is rejected before posting", async () => {
    seed({ gen: { teamsJson: JSON.stringify([{ players: "x" }]) } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(422);
    expectNoSideEffects();
  });

  it("missing bot token fails before any Telegram call or claim", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(500);
    expectNoSideEffects();
  });

  it("body groupId is ignored — lookups and claim stay on the URL-resolved Group", async () => {
    const res = await POST(req({ ...BODY, groupId: "group-b" }), ctx());
    expect(res.status).toBe(200);
    expect(pollFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
    expect(genFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
    for (const call of pollUpdateMany.mock.calls) expect(call[0].where.groupId).toBe("group-a");
    expect(polls.get("poll-b")!.teamsPostStatus).toBeNull();
  });

  it("body organizationId is ignored — tenant comes only from the URL", async () => {
    await POST(req({ ...BODY, organizationId: "org-b", organizationSlug: "org-b", groupSlug: "group-b" }), ctx());
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledTimes(1);
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });
});

describe("canonical close-and-post — posting state machine", () => {
  it("first claim (count===1) sends exactly once, using a conditional updateMany on NULL", async () => {
    await POST(req(BODY), ctx());
    const claimCall = pollUpdateMany.mock.calls.find((c) => c[0].data.teamsPostStatus === "SENDING")!;
    expect(claimCall[0].where).toEqual({ pollId: "poll-1", groupId: "group-a", teamsPostStatus: null });
    expect(claimCall[0].data).toMatchObject({ postedTeamGenerationId: "gen-1" });
    expect(sends()).toHaveLength(1);
  });

  it("POSTED + same generation → 200 already_posted, no send", async () => {
    seed({ poll: { isClosed: true, teamsPostStatus: "POSTED", postedTeamGenerationId: "gen-1" } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "already_posted" });
    expect(sends()).toHaveLength(0);
    expect(tgCalls).toHaveLength(0);
  });

  it("POSTED + same generation still closes a poll that is open (idempotent), but never sends", async () => {
    seed({ poll: { teamsPostStatus: "POSTED", postedTeamGenerationId: "gen-1" } });
    const res = await POST(req(BODY), ctx());
    expect(await res.json()).toMatchObject({ status: "already_posted", closeStatus: "closed_now" });
    expect(sends()).toHaveLength(0);
  });

  it("APPROVED D.5D behavior: republishing the same (groupId,date) with different teams keeps the same id, returns already_posted, and never sends the revised teams", async () => {
    const first = await POST(req(BODY), ctx());
    expect((await first.json()).status).toBe("posted");
    expect(sends()).toHaveLength(1);
    const postedAt = polls.get("poll-1")!.teamsPostedAt;

    // Publish's (groupId,date) upsert rewrites teamsJson on the SAME row/id.
    gens.get("gen-1")!.teamsJson = JSON.stringify([
      { teamNumber: 1, players: [{ firstName: "Revised", lastName: "Player" }] },
      { teamNumber: 2, players: [{ firstName: "Other", lastName: "Revised" }] },
    ]);

    const second = await POST(req(BODY), ctx());
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("already_posted");

    // No second send, no revised content ever reached Telegram, record unchanged.
    expect(sends()).toHaveLength(1);
    expect(tgCalls.some((c) => String(c.body.text ?? "").includes("Revised"))).toBe(false);
    const row = polls.get("poll-1")!;
    expect(row.teamsPostStatus).toBe("POSTED");
    expect(row.postedTeamGenerationId).toBe("gen-1");
    expect(row.teamsPostedAt).toBe(postedAt);
  });

  it("POSTED + different generation → 409, no Telegram call, history unchanged", async () => {
    const postedAt = new Date("2026-09-01T00:00:00Z");
    seed({ poll: { teamsPostStatus: "POSTED", postedTeamGenerationId: "gen-old", teamsPostedAt: postedAt } });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe("already_posted_different_generation");
    expect(tgCalls).toHaveLength(0);
    expect(pollUpdateMany).not.toHaveBeenCalled();
    const row = polls.get("poll-1")!;
    expect(row.postedTeamGenerationId).toBe("gen-old");
    expect(row.teamsPostedAt).toBe(postedAt);
  });

  it("SENDING → 409 post_in_progress_or_unknown, no Telegram call, tells Admin to verify the chat", async () => {
    seed({ poll: { teamsPostStatus: "SENDING", postedTeamGenerationId: "gen-1" } });
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.status).toBe("post_in_progress_or_unknown");
    expect(data.error).toMatch(/may have reached Telegram/);
    expect(data.error).toMatch(/do not retry automatically/);
    expect(tgCalls).toHaveLength(0);
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("SENDING");
  });

  it("claim race (count===0) re-reads state and resolves it without sending or re-claiming", async () => {
    // Pre-read sees NULL; a competing request claims between our read and our claim.
    pollUpdateMany.mockImplementationOnce(async ({ where, data }) => {
      // this is the isClosed sync after stopPoll — apply it normally
      for (const row of polls.values()) if (matches(row, where)) Object.assign(row, data);
      const row = polls.get("poll-1")!;
      row.teamsPostStatus = "SENDING";
      row.postedTeamGenerationId = "gen-1";
      return { count: 1 };
    });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe("post_in_progress_or_unknown");
    expect(sends()).toHaveLength(0);
    const claimAttempts = pollUpdateMany.mock.calls.filter((c) => c[0].data.teamsPostStatus === "SENDING");
    expect(claimAttempts).toHaveLength(1);
    // re-read after failed claim is Group-scoped
    expect(pollFindFirst.mock.calls.at(-1)![0].where).toEqual({ pollId: "poll-1", groupId: "group-a" });
  });

  it("claim race resolved to POSTED-same after re-read → already_posted, no send", async () => {
    seed({ poll: { isClosed: true } });
    pollUpdateMany.mockImplementationOnce(async () => {
      const row = polls.get("poll-1")!;
      row.teamsPostStatus = "POSTED";
      row.postedTeamGenerationId = "gen-1";
      return { count: 0 };
    });
    const res = await POST(req(BODY), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("already_posted");
    expect(sends()).toHaveLength(0);
  });

  it("two concurrent requests: only one acquires the claim and sends", async () => {
    seed({ poll: { isClosed: true } });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((r) => (releaseSend = r));
    tgHandler = async (m) => {
      if (m === "sendMessage") await sendGate;
      return okResponse();
    };

    const p1 = POST(req(BODY), ctx());
    const p2 = POST(req(BODY), ctx());
    // Let both requests get past validation and attempt the claim.
    await new Promise((r) => setTimeout(r, 20));
    releaseSend();
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [(await r1.json()).status, (await r2.json()).status].sort();

    expect(sends()).toHaveLength(1);
    expect(statuses).toEqual(["post_in_progress_or_unknown", "posted"]);
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("POSTED");
  });

  it("definite Telegram rejection resets ONLY our own SENDING claim and permits a later retry", async () => {
    tgHandler = async (m) => (m === "sendMessage" ? rejectResponse("Bad Request: chat not found") : okResponse());
    const res = await POST(req(BODY), ctx());
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data).toMatchObject({ ok: false, status: "telegram_rejected", claimReleased: true });
    const resetCall = pollUpdateMany.mock.calls.find((c) => c[0].data.teamsPostStatus === null)!;
    expect(resetCall[0].where).toEqual({
      pollId: "poll-1",
      groupId: "group-a",
      teamsPostStatus: "SENDING",
      postedTeamGenerationId: "gen-1",
    });
    const row = polls.get("poll-1")!;
    expect(row.teamsPostStatus).toBeNull();
    expect(row.postedTeamGenerationId).toBeNull();
    expect(row.teamsPostClaimedAt).toBeNull();
    expect(row.teamsPostedAt).toBeNull();

    // explicit later retry succeeds
    tgHandler = async () => okResponse();
    const retry = await POST(req(BODY), ctx());
    expect((await retry.json()).status).toBe("posted");
  });

  it("definite rejection does not clobber a claim that is no longer ours", async () => {
    tgHandler = async (m) => {
      if (m === "sendMessage") {
        // someone else's state replaced ours mid-flight
        const row = polls.get("poll-1")!;
        row.postedTeamGenerationId = "gen-other";
        return rejectResponse("Bad Request: chat not found");
      }
      return okResponse();
    };
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(data).toMatchObject({ status: "telegram_rejected", claimReleased: false });
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("SENDING");
    expect(polls.get("poll-1")!.postedTeamGenerationId).toBe("gen-other");
  });

  it("ambiguous transport failure leaves SENDING and reports delivery_unknown", async () => {
    tgHandler = async (m) => {
      if (m === "sendMessage") throw new TypeError("fetch failed");
      return okResponse();
    };
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.status).toBe("delivery_unknown");
    expect(data.error).not.toMatch(/Nothing was posted/);
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("SENDING");
    expect(sends()).toHaveLength(1);

    // a later request cannot auto-resend
    const again = await POST(req(BODY), ctx());
    expect((await again.json()).status).toBe("post_in_progress_or_unknown");
    expect(sends()).toHaveLength(1);
  });

  it("unparseable Telegram response is ambiguous, not a rejection", async () => {
    tgHandler = async (m) =>
      m === "sendMessage" ? { json: async () => { throw new SyntaxError("Unexpected token <"); } } : okResponse();
    const res = await POST(req(BODY), ctx());
    expect((await res.json()).status).toBe("delivery_unknown");
    expect(polls.get("poll-1")!.teamsPostStatus).toBe("SENDING");
  });

  it("successful send transitions SENDING → POSTED via our-claim-only conditional update", async () => {
    await POST(req(BODY), ctx());
    const confirm = pollUpdateMany.mock.calls.find((c) => c[0].data.teamsPostStatus === "POSTED")!;
    expect(confirm[0].where).toEqual({
      pollId: "poll-1",
      groupId: "group-a",
      teamsPostStatus: "SENDING",
      postedTeamGenerationId: "gen-1",
    });
  });

  it("successful send + zero-row confirmation → anomaly, never resends", async () => {
    tgHandler = async (m) => {
      if (m === "sendMessage") {
        polls.get("poll-1")!.teamsPostStatus = null; // local state drifted
      }
      return okResponse();
    };
    const res = await POST(req(BODY), ctx());
    const data = await res.json();
    expect(res.status).toBe(500);
    expect(data.status).toBe("delivered_confirmation_failed");
    expect(data.error).toMatch(/Do not retry/);
    expect(sends()).toHaveLength(1);
  });

  it("successful send + confirmation DB error → anomaly, never resends", async () => {
    let n = 0;
    pollUpdateMany.mockImplementation(async ({ where, data }) => {
      n++;
      if (data.teamsPostStatus === "POSTED") throw new Error("db down");
      let count = 0;
      for (const row of polls.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
      return { count };
    });
    const res = await POST(req(BODY), ctx());
    expect((await res.json()).status).toBe("delivered_confirmation_failed");
    expect(sends()).toHaveLength(1);
    expect(n).toBeGreaterThan(0);
  });
});

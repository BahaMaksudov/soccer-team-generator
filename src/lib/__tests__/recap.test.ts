import { describe, it, expect, vi } from "vitest";
import { buildRecapFacts, contradictsFacts, deterministicRecap, generateAiRecap, RECAP_MAX_OUTPUT_TOKENS, RECAP_SYSTEM_PROMPT, sanitizeRecapText, unsupportedClaims, type RecapFacts } from "@/lib/recap";
import { AiError, DEFAULT_OPENAI_MODEL, extractResponseText, openAiCompleter } from "@/lib/ai/openai";

/** M9-D — recap facts, deterministic recap and the AI language layer (no live AI calls). */

const POLLUTED = {
  sportLabel: "Soccer",
  date: "2026-10-05",
  locationName: "Field 2",
  scores: [
    { teamNumber: 1, score: 7, teamId: "secret-team-id" },
    { teamNumber: 2, score: 5, rating: "EXCELLENT" },
  ],
  mvpNames: ["Bahrom M"],
  participantCount: 10,
  // everything below must never reach the AI payload
  playerIds: ["cplayer123", "cplayer456"],
  userId: "cuser789",
  email: "player@example.com",
  telegramUserId: 123456789n.toString(),
  telegramUsername: "@bahrom",
  chatId: "-100555",
  ratings: { cplayer123: "EXCELLENT" },
  stamina: { cplayer123: 5 },
  metricsJson: '{"spread":3}',
  analysis: { quality: "EVEN" },
  organizerNotes: "private",
  players: [{ id: "cplayer123", firstName: "Bahrom", lastName: "M", rating: "EXCELLENT", stamina: 5, userId: "cuser789" }],
};

const FACTS: RecapFacts = buildRecapFacts(POLLUTED)!;

describe("buildRecapFacts — the AI privacy boundary", () => {
  it("keeps only approved facts; ids, emails, Telegram identity, ratings, stamina, metrics and notes never pass", () => {
    expect(FACTS).toEqual({
      sport: "Soccer",
      date: "2026-10-05",
      venue: "Field 2",
      teams: [
        { name: "Team 1", score: 7 },
        { name: "Team 2", score: 5 },
      ],
      outcome: { kind: "WIN", winner: "Team 1" },
      scoreLine: "7–5",
      mvp: ["Bahrom M"],
      participants: 10,
    });
    const payload = JSON.stringify(FACTS);
    for (const banned of ["cplayer", "cuser", "example.com", "123456789", "@bahrom", "-100555", "EXCELLENT", "stamina", "rating", "metrics", "spread", "quality", "private", "secret-team-id"]) {
      expect(payload, banned).not.toContain(banned);
    }
  });
  it("the application computes winner/draw and score — never the AI", () => {
    expect(buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 2, score: 5 }, { teamNumber: 1, score: 5 }] })).toMatchObject({ outcome: { kind: "DRAW" }, scoreLine: "5–5", mvp: [] });
    expect(buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 68 }, { teamNumber: 2, score: 72 }] })).toMatchObject({ outcome: { kind: "WIN", winner: "Team 2" }, scoreLine: "68–72" });
    expect(buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 1 }] })).toBeNull();
    expect(buildRecapFacts({ scores: [{ teamNumber: 1, score: 1 }, { teamNumber: 2, score: 0 }] })).toBeNull();
  });
});

describe("deterministic recap — verified facts only", () => {
  it("win / draw / co-MVP / no MVP / three teams; no invented performance claims", () => {
    expect(deterministicRecap(FACTS)).toBe("Team 1 beat Team 2, 7–5. Player of the Match: Bahrom M. Thanks to everyone who played!");
    const draw = buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 5 }], mvpNames: ["A", "B"] })!;
    expect(deterministicRecap(draw)).toBe("The match finished 5–5. Players of the Match: A and B. Thanks to everyone who played!");
    const noMvp = buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 3 }] })!;
    expect(deterministicRecap(noMvp)).toBe("Team 2 beat Team 1, 3–2. Thanks to everyone who played!");
    const three = buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }, { teamNumber: 3, score: 2 }] })!;
    expect(deterministicRecap(three)).toBe("Final: Team 1 3, Team 2 1, Team 3 2. Team 1 took the win. Thanks to everyone who played!");
    for (const t of [deterministicRecap(FACTS), deterministicRecap(draw)]) expect(t).not.toMatch(/comeback|dominant|defen[cs]e|hat.trick|goal|assist|save/i);
  });
});

describe("AI output validation", () => {
  it("strips markup and control characters; empty → null", () => {
    expect(sanitizeRecapText("  <b>Great</b> game!\u0007 ")).toBe("Great game!");
    expect(sanitizeRecapText("   ")).toBeNull();
    expect(sanitizeRecapText("<p></p>")).toBeNull();
  });
  it("a different score in the text is a contradiction; the real score (either order) is not", () => {
    expect(contradictsFacts("Team 1 won 7–5!", FACTS)).toBe(false);
    expect(contradictsFacts("Team 2 fell 5-7.", FACTS)).toBe(false);
    expect(contradictsFacts("Team 1 won 8–5!", FACTS)).toBe(true);
  });
  it("the system prompt: match-day voice personality + strict factual boundary", () => {
    const p = RECAP_SYSTEM_PROMPT;
    expect(p).toContain("You are the match-day voice of Team Balance Pro");
    for (const tone of ["Fun, energetic, playful and conversational", "friendly banter", "Never corporate, robotic or database-like", "insulting", "bragging rights", "until the rematch"]) expect(p, tone).toContain(tone);
    for (const rule of ["ONLY source of truth", "Never change or reinterpret", "simple arithmetic", "eight goals hit the scoreboard", "a two-goal win", "Never say why they won", "If `mvp` is empty, do not mention an MVP", "do not explain how it ended level", "more than two teams"]) expect(p, rule).toContain(rule);
    for (const banned of ["goal scorers", "assists", "saves", "tackles", "cards", "penalties", "overtime", "halftime scores", "lead changes", "comebacks", "individual performances", "specific plays", "injuries", "weather", "crowd or player behavior", "rivalries", "previous results", "records or streaks"]) expect(p, banned).toContain(banned);
    for (const style of ["2–4 short sentences", "1–3 fitting emojis", "Vary the opening", "no heading", "no markdown", "no JSON", "no explanations or disclaimers", "Return only the recap text."]) expect(p, style).toContain(style);
    expect(p).not.toMatch(/cplayer|@|rating|stamina/i); // the prompt itself carries no data
});
});

describe("generateAiRecap — mocked provider (never live)", () => {
  it("success: the provider receives only the facts JSON", async () => {
    const complete = vi.fn(async () => "What a night! Team 1 took it 7–5 and Bahrom M was Player of the Match ⚽");
    expect(await generateAiRecap(FACTS, complete)).toEqual({ ok: true, text: "What a night! Team 1 took it 7–5 and Bahrom M was Player of the Match ⚽" });
    expect(complete).toHaveBeenCalledWith({ system: RECAP_SYSTEM_PROMPT, user: JSON.stringify(FACTS), maxTokens: RECAP_MAX_OUTPUT_TOKENS });
  });
  it.each([
    ["timeout", async (): Promise<string> => { throw new AiError("TIMEOUT"); }, "TIMEOUT"],
    ["rate limit", async (): Promise<string> => { throw new AiError("RATE_LIMITED"); }, "RATE_LIMITED"],
    ["provider error", async (): Promise<string> => { throw new AiError("PROVIDER_ERROR"); }, "PROVIDER_ERROR"],
    ["unexpected throw", async (): Promise<string> => { throw new Error("boom"); }, "PROVIDER_ERROR"],
    ["not configured", async (): Promise<string> => { throw new AiError("NOT_CONFIGURED"); }, "NOT_CONFIGURED"],
    ["incomplete response", async (): Promise<string> => { throw new AiError("INCOMPLETE"); }, "INCOMPLETE"],
    ["empty output", async (): Promise<string> => "   ", "EMPTY"],
    ["overlong output", async (): Promise<string> => "x".repeat(1201), "TOO_LONG"],
    ["changed score", async (): Promise<string> => "Team 1 won 9–1!", "INCONSISTENT"],
  ] as const)("%s → a safe failure the caller can fall back from", async (_n, impl, code) => {
    const r = await generateAiRecap(FACTS, impl as () => Promise<string>);
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) expect(r.message).toMatch(/standard recap/);
  });
});

const completed = (text: string) => ({
  id: "resp_1",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
  ],
});

describe("extractResponseText — Responses API output", () => {
  it("joins the output_text parts of assistant message items; ignores reasoning items", () => {
    expect(extractResponseText(completed("Great game!"))).toBe("Great game!");
    expect(
      extractResponseText({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "A " }, { type: "output_text", text: "B" }] }] })
    ).toBe("A B");
  });
  it.each([
    ["incomplete (e.g. max_output_tokens)", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "INCOMPLETE"],
    ["failed", { status: "failed", error: null, output: [] }, "PROVIDER_ERROR"],
    ["error object", { status: "completed", error: { code: "server_error" }, output: [] }, "PROVIDER_ERROR"],
    ["refusal only", { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, "EMPTY"],
    ["reasoning only", { status: "completed", output: [{ type: "reasoning", summary: [] }] }, "EMPTY"],
    ["blank text", completed("   "), "EMPTY"],
    ["no output array", { status: "completed" }, "INVALID"],
    ["unknown status", { status: "queued", output: [] }, "INVALID"],
    ["not an object", null, "INVALID"],
    ["chat-completions shape", { choices: [{ message: { content: "x" } }] }, "INVALID"],
  ] as const)("%s → AiError %s", (_n, body, code) => {
    expect(() => extractResponseText(body)).toThrow(expect.objectContaining({ code }));
  });
});

describe("openAiCompleter — Responses API over HTTP (mocked fetch)", () => {
  const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  const input = { system: "s", user: "u", maxTokens: 10 };

  it("not configured without OPENAI_API_KEY (no request made)", async () => {
    const f = vi.fn();
    await expect(openAiCompleter({}, f as never)(input)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(f).not.toHaveBeenCalled();
  });
  it("POST /v1/responses: model, instructions + facts input, bounded output, low reasoning, plain text, no tools, not stored; key only in the header", async () => {
    const f = vi.fn(async () => ok(completed("hi")));
    expect(await openAiCompleter({ OPENAI_API_KEY: "sk-test" }, f as never)(input)).toBe("hi");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: DEFAULT_OPENAI_MODEL,
      instructions: "s",
      input: "u",
      max_output_tokens: 10,
      reasoning: { effort: "low" },
      text: { format: { type: "text" } },
      store: false,
    });
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6-luna");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("messages");
    expect(String(init.body)).not.toContain("sk-test");
  });
  it("OPENAI_MODEL / OPENAI_REASONING_EFFORT / OPENAI_BASE_URL are configurable ('off' omits reasoning)", async () => {
    const f = vi.fn(async () => ok(completed("hi")));
    await openAiCompleter({ OPENAI_API_KEY: "k", OPENAI_MODEL: "custom-model", OPENAI_REASONING_EFFORT: "minimal", OPENAI_BASE_URL: "https://proxy.example/v1/" }, f as never)(input);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.example/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "custom-model", reasoning: { effort: "minimal" } });
    await openAiCompleter({ OPENAI_API_KEY: "k", OPENAI_REASONING_EFFORT: "off" }, f as never)(input);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty("reasoning");
  });
  it("429 → RATE_LIMITED, 500 → PROVIDER_ERROR, incomplete → INCOMPLETE, malformed → INVALID, network → PROVIDER_ERROR; errors never carry the key", async () => {
    const env = { OPENAI_API_KEY: "sk-secret" };
    await expect(openAiCompleter(env, (async () => ok({}, 429)) as never)(input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(openAiCompleter(env, (async () => ok({ error: "sk-secret" }, 500)) as never)(input)).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: "PROVIDER_ERROR" });
    await expect(openAiCompleter(env, (async () => ok({ status: "incomplete", output: [] })) as never)(input)).rejects.toMatchObject({ code: "INCOMPLETE" });
    await expect(openAiCompleter(env, (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }) as unknown as Response) as never)(input)).rejects.toMatchObject({ code: "INVALID" });
    await expect(openAiCompleter(env, (async () => { throw new TypeError("fetch failed"); }) as never)(input)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("a slow provider is aborted after the bounded timeout → TIMEOUT", async () => {
    const slow = (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    await expect(openAiCompleter({ OPENAI_API_KEY: "k" }, slow as never, 20)(input)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

// ------------------------------------------------------------------ personality upgrade: fact guards
const FORE: RecapFacts = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", locationName: "Forekicks", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }], mvpNames: [], participantCount: 10 })!;
const FORE_MVP: RecapFacts = { ...FORE, mvp: ["Azizbek"] };
const DRAW: RecapFacts = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", scores: [{ teamNumber: 1, score: 4 }, { teamNumber: 2, score: 4 }], participantCount: 10 })!;
const THREE: RecapFacts = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }, { teamNumber: 3, score: 2 }], participantCount: 15 })!;

describe("AI recap personality — playful phrasing of verified facts is accepted", () => {
  it.each([
    [FORE, "Forekicks delivered! Team 1 grabbed the bragging rights with a 5–3 win — eight goals hit the scoreboard. Team 2, the rematch awaits ⚽🔥"],
    [FORE, "A busy scoreboard at Forekicks: Team 1 edged it 5–3 in a two-goal win. Plenty to talk about in the group chat until next week! 😄"],
    [FORE_MVP, "Team 1 takes it 5–3 at Forekicks! Player of the Match honors go to Azizbek! 🏆 Team 2 — back to the drawing board."],
    [DRAW, "No bragging rights this week — Team 1 and Team 2 finished 4–4. Eight goals and still no winner, so the rematch will have to settle it. ⚽"],
    [THREE, "Three teams, one winner: Team 1 topped the table with 3, Team 3 grabbed 2 and Team 2 got 1. Bragging rights secured! 🏅"],
  ] as const)("%#: accepted", async (facts, text) => {
    expect(unsupportedClaims(text, facts)).toBeNull();
    expect(await generateAiRecap(facts, async () => text)).toEqual({ ok: true, text });
  });
});

describe("AI recap personality — unsupported or changed facts fall back safely", () => {
  it.each([
    ["changed score", FORE, "Team 1 won 6–3 at Forekicks!"],
    ["comeback story", FORE, "What a comeback from Team 1, winning 5–3!"],
    ["came back", FORE, "Team 1 came back to win 5–3."],
    ["hat-trick", FORE, "A hat-trick sealed Team 1's 5–3 win."],
    ["saves", FORE, "Big saves kept Team 1 ahead, 5–3."],
    ["assists", FORE, "Slick assists all night as Team 1 won 5–3."],
    ["halftime", FORE, "Level at half-time, Team 1 pulled away 5–3."],
    ["penalty", FORE, "A late penalty decided it, 5–3."],
    ["injury", FORE, "Despite an injury, Team 1 won 5–3."],
    ["card", FORE, "A yellow card couldn't stop Team 1, 5–3."],
    ["invented MVP (none published)", FORE, "Team 1 won 5–3 and Player of the Match goes to Azizbek! 🏆"],
    ["wrong MVP name", FORE_MVP, "Team 1 won 5–3. Player of the Match: Ravshan! 🏆"],
    ["draw turned into a win", DRAW, "Team 2 won it 4–4 on vibes alone."],
    ["loser declared winner", FORE, "Team 2 beat Team 1 5–3!"],
  ] as const)("%s → INCONSISTENT (standard recap offered)", async (_n, facts, text) => {
    const r = await generateAiRecap(facts, async () => text);
    expect(r).toMatchObject({ ok: false, code: "INCONSISTENT" });
    if (!r.ok) expect(r.message).toMatch(/standard recap/);
  });

  it("the MVP name in the payload comes only from published MVP facts (no MVP published → empty list)", () => {
    expect(FORE.mvp).toEqual([]);
    expect(buildRecapFacts({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }], mvpNames: ["Azizbek"], candidates: ["Ravshan"], votes: { Ravshan: 3 } })!.mvp).toEqual(["Azizbek"]);
  });

  it("the provider still receives exactly the facts JSON — nothing more", async () => {
    const complete = vi.fn(async (_input: { system: string; user: string; maxTokens: number }) => "Team 1 won 5–3! ⚽");
    await generateAiRecap(FORE, complete);
    const call = complete.mock.calls[0][0];
    expect(JSON.parse(call.user)).toEqual({ sport: "Soccer", date: "2026-10-05", venue: "Forekicks", teams: [{ name: "Team 1", score: 5 }, { name: "Team 2", score: 3 }], outcome: { kind: "WIN", winner: "Team 1" }, scoreLine: "5–3", mvp: [], participants: 10 });
    expect(call.system).toBe(RECAP_SYSTEM_PROMPT);
  });
});

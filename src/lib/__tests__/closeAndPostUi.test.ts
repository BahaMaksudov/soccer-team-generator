import { describe, it, expect } from "vitest";
import {
  canCloseAndPost,
  describeCloseAndPostResult,
  publishedGenerationFromPublishResponse,
} from "@/lib/closeAndPostUi";

describe("publishedGenerationFromPublishResponse", () => {
  it("retains the saved TeamGeneration id and the UTC calendar date from Publish", () => {
    expect(publishedGenerationFromPublishResponse({ ok: true, id: "gen-1" }, "2026-09-28T00:00:00.000Z")).toEqual({
      id: "gen-1",
      date: "2026-09-28",
    });
  });

  it("returns null when the response carries no id", () => {
    expect(publishedGenerationFromPublishResponse({ ok: true }, "2026-09-28T00:00:00.000Z")).toBeNull();
    expect(publishedGenerationFromPublishResponse(null, "2026-09-28T00:00:00.000Z")).toBeNull();
  });
});

describe("canCloseAndPost — eligibility uses ONLY the persisted pollDate", () => {
  const gen = { id: "gen-1", date: "2026-09-28" };
  // Shaped like the canonical polls API item: `pollDate` may be derived
  // from question text; `persistedPollDate` is the column only.
  const pollItem = (persistedPollDate: string | null, question: string, pollDate: string | null) => ({
    persistedPollDate,
    question,
    pollDate,
  });

  it("real pollDate matching the published generation → eligible", () => {
    const poll = pollItem("2026-09-28", "Who is playing on 9/28/26?", "2026-09-28");
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: false })).toBe(true);
  });

  it("real pollDate mismatching the published generation → not eligible", () => {
    const poll = pollItem("2026-09-29", "Who is playing on 9/28/26?", "2026-09-29");
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: false })).toBe(false);
  });

  it("pollDate null + question containing the matching date (question-derived pollDate matches) → NOT eligible", () => {
    // "9/28/26" is the form resolvePollCalendarDate() actually parses,
    // so the display pollDate here genuinely equals the generation date.
    const poll = pollItem(null, "Who is playing on 9/28/26?", "2026-09-28");
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: false })).toBe(false);
  });

  it("pollDate null + question with a 4-digit-year matching date → NOT eligible", () => {
    const poll = pollItem(null, "Who is playing on 9/28/2026?", null);
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: false })).toBe(false);
  });

  it("pollDate null + arbitrary question → NOT eligible", () => {
    const poll = pollItem(null, "Anyone up for football?", null);
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: false })).toBe(false);
  });

  it("requires a publishedGeneration (an old poll alone is not enough)", () => {
    const poll = pollItem("2026-09-28", "Q", "2026-09-28");
    expect(canCloseAndPost({ poll, publishedGeneration: null, running: false })).toBe(false);
  });

  it("requires a selected poll", () => {
    expect(canCloseAndPost({ poll: null, publishedGeneration: gen, running: false })).toBe(false);
    expect(canCloseAndPost({ poll: undefined, publishedGeneration: gen, running: false })).toBe(false);
  });

  it("is disabled while a request is running", () => {
    const poll = pollItem("2026-09-28", "Q", "2026-09-28");
    expect(canCloseAndPost({ poll, publishedGeneration: gen, running: true })).toBe(false);
  });
});

describe("describeCloseAndPostResult", () => {
  it.each([
    ["posted", true, "success"],
    ["already_posted", true, "success"],
    ["updated_available", false, "warning"],
    ["delivery_uncertain", false, "warning"],
    ["marked_sent", true, "success"],
    ["post_in_progress_or_unknown", false, "warning"],
    ["telegram_rejected", false, "error"],
    ["delivery_unknown", false, "warning"],
    ["delivered_confirmation_failed", false, "warning"],
  ])("%s → %s tone", (status, ok, tone) => {
    expect(describeCloseAndPostResult(ok as boolean, { status }).tone).toBe(tone);
  });

  it("ambiguous outcomes tell the Admin to check the chat, never to retry", () => {
    for (const status of ["post_in_progress_or_unknown", "delivery_unknown", "delivered_confirmation_failed"]) {
      const { message } = describeCloseAndPostResult(false, { status });
      expect(message).toMatch(/do not retry/i);
    }
  });

  it("includes the close outcome", () => {
    expect(describeCloseAndPostResult(true, { status: "posted", closeStatus: "closed_now" }).message).toMatch(
      /Poll closed/
    );
  });

  it("falls back to the server error for other failures", () => {
    expect(describeCloseAndPostResult(false, { error: "Poll not found" })).toEqual({
      tone: "error",
      message: "Poll not found",
    });
  });
});

import { deliveryActions, deliveryStatusLabel, intentForAction } from "@/lib/closeAndPostUi";

describe("M6-B delivery actions — only actions safe for the state are offered", () => {
  it.each([
    ["not_posted", ["post"]],
    ["failed", ["retry_failed"]],
    ["updated_available", ["post_updated"]],
    ["uncertain", ["mark_sent", "retry_uncertain"]],
    ["posted", []],
    ["sending", []],
    [null, []],
  ] as const)("%s → %j", (state, actions) => {
    expect(deliveryActions(state)).toEqual(actions);
  });

  it("maps actions to explicit server intents (mark_sent is not a send)", () => {
    expect(intentForAction("post")).toBe("post");
    expect(intentForAction("retry_failed")).toBe("post");
    expect(intentForAction("post_updated")).toBe("post_updated");
    expect(intentForAction("retry_uncertain")).toBe("retry_uncertain");
    expect(intentForAction("mark_sent")).toBeNull();
  });

  it("labels every state", () => {
    for (const s of ["not_posted", "sending", "posted", "failed", "uncertain", "updated_available"] as const) {
      expect(deliveryStatusLabel(s).length).toBeGreaterThan(0);
    }
  });
});

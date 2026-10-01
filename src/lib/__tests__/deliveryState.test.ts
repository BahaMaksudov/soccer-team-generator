import { describe, it, expect } from "vitest";
import { deliveryStateOf, isSameContent, contentHashOf, STALE_SENDING_MS, type DeliveryRecord } from "@/lib/messaging/deliveryState";

const NOW = new Date("2026-10-05T20:00:00Z");
const current = { contentHash: contentHashOf("teams v1"), teamGenerationId: "gen", generationUpdatedAt: new Date("2026-10-05T18:00:00Z") };
let n = 0;
const d = (over: Partial<DeliveryRecord>): DeliveryRecord => ({
  id: `d${++n}`,
  status: "SENT",
  contentHash: current.contentHash,
  teamGenerationId: "gen",
  claimedAt: new Date(NOW.getTime() - 10_000),
  sentAt: new Date(NOW.getTime() - 5_000),
  createdAt: new Date(NOW.getTime() - 10_000 + n),
  ...over,
});

describe("deliveryStateOf", () => {
  it("nothing → not_posted", () => expect(deliveryStateOf([], current, NOW).kind).toBe("not_posted"));
  it("SENT same content → posted", () => expect(deliveryStateOf([d({})], current, NOW).kind).toBe("posted"));
  it("SENT different content → updated_available", () =>
    expect(deliveryStateOf([d({ contentHash: contentHashOf("teams v0") })], current, NOW).kind).toBe("updated_available"));
  it("FAILED latest → failed (retryable)", () => expect(deliveryStateOf([d({ status: "FAILED", sentAt: null })], current, NOW).kind).toBe("failed"));
  it("UNCERTAIN latest → uncertain, even after an earlier SENT", () =>
    expect(deliveryStateOf([d({}), d({ status: "UNCERTAIN", sentAt: null })], current, NOW).kind).toBe("uncertain"));
  it("fresh SENDING → sending; stale SENDING → uncertain", () => {
    expect(deliveryStateOf([d({ status: "SENDING", sentAt: null, claimedAt: new Date(NOW.getTime() - 1000) })], current, NOW).kind).toBe("sending");
    expect(
      deliveryStateOf([d({ status: "SENDING", sentAt: null, claimedAt: new Date(NOW.getTime() - STALE_SENDING_MS - 1) })], current, NOW).kind
    ).toBe("uncertain");
  });
  it("an earlier SENT with the current content wins over a later FAILED updated attempt", () =>
    expect(deliveryStateOf([d({}), d({ status: "FAILED", contentHash: contentHashOf("v2"), sentAt: null })], current, NOW).kind).toBe("posted"));
  it("input order does not matter (newest decides)", () => {
    const rows = [d({}), d({ status: "UNCERTAIN", sentAt: null })];
    expect(deliveryStateOf([...rows].reverse(), current, NOW).kind).toBe("uncertain");
  });
});

describe("legacy rows (content unknown)", () => {
  const legacy = d({ contentHash: "legacy", sentAt: new Date("2026-10-05T19:00:00Z") });
  it("same generation, not republished since → same content", () => expect(isSameContent(legacy, current)).toBe(true));
  it("republished after the post → different", () =>
    expect(isSameContent(legacy, { ...current, generationUpdatedAt: new Date("2026-10-05T19:30:00Z") })).toBe(false));
  it("a different generation → different", () => expect(isSameContent(legacy, { ...current, teamGenerationId: "other" })).toBe(false));
  it("no sentAt → different (never assumed delivered content)", () => expect(isSameContent({ ...legacy, sentAt: null }, current)).toBe(false));
});

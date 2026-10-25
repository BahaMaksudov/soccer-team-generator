import { describe, it, expect } from "vitest";
import { billingStatusNote, scheduledEnd, type SubscriptionView } from "@/lib/billing/statusNote";

/** M11.2B — scheduled cancellation: when access ends, and what the Billing page says (offline). */
const NOV25 = new Date(1_795_577_883 * 1000); // the confirmed Sandbox cancel_at (2026-11-25)
const DEC31 = new Date("2026-12-31T12:00:00Z");
const row = (patch: Partial<Parameters<typeof scheduledEnd>[0]> = {}) => ({ status: "active", cancelAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: NOV25, ...patch });
const view = (patch: Partial<SubscriptionView> = {}): SubscriptionView => ({ status: "active", interval: "month", currentPeriodEnd: NOV25.toISOString(), accessEndsAt: null, endedAt: null, ...patch });

describe("scheduledEnd", () => {
  it("renewing subscription → no end date", () => {
    expect(scheduledEnd(row())).toBeNull();
  });
  it("Customer Portal: cancel_at set, cancel_at_period_end false → ends at cancel_at", () => {
    expect(scheduledEnd(row({ cancelAt: NOV25 }))).toEqual(NOV25);
  });
  it("traditional cancel_at_period_end=true → ends at the period end", () => {
    expect(scheduledEnd(row({ cancelAtPeriodEnd: true }))).toEqual(NOV25);
  });
  it("cancel_at different from the period end → the actual cancel_at date wins", () => {
    expect(scheduledEnd(row({ cancelAt: DEC31, currentPeriodEnd: NOV25 }))).toEqual(DEC31);
    expect(scheduledEnd(row({ cancelAt: DEC31, cancelAtPeriodEnd: true, currentPeriodEnd: NOV25 }))).toEqual(DEC31);
  });
  it("already ended → no scheduled end", () => {
    expect(scheduledEnd(row({ status: "canceled", cancelAt: NOV25 }))).toBeNull();
    expect(scheduledEnd(row({ status: "incomplete_expired", cancelAtPeriodEnd: true }))).toBeNull();
  });
});

describe("Billing page status line", () => {
  it("renewing: monthly and annual", () => {
    expect(billingStatusNote(view())).toEqual({ tone: "ok", text: "Pro (monthly) renews on Nov 25, 2026." });
    expect(billingStatusNote(view({ interval: "year", currentPeriodEnd: "2027-10-25T08:00:00Z" }))).toEqual({ tone: "ok", text: "Pro (annual) renews on Oct 25, 2027." });
  });
  it("scheduled cancellation: says when access ends, never 'renews' (monthly and annual)", () => {
    for (const interval of ["month", "year"]) {
      const note = billingStatusNote(view({ interval, accessEndsAt: NOV25.toISOString() }));
      expect(note, interval).toEqual({ tone: "info", text: "Pro access ends on Nov 25, 2026. You can resume your subscription before then." });
      expect(note!.text).not.toMatch(/renews/);
    }
    expect(billingStatusNote(view({ accessEndsAt: DEC31.toISOString() }))!.text).toBe("Pro access ends on Dec 31, 2026. You can resume your subscription before then.");
  });
  it("dates are UTC (an instant late on Nov 25 UTC is still Nov 25)", () => {
    expect(billingStatusNote(view({ currentPeriodEnd: "2026-11-25T23:30:00Z" }))!.text).toContain("Nov 25, 2026");
  });
  it("other states keep their messages", () => {
    expect(billingStatusNote(null)).toBeNull();
    expect(billingStatusNote(view({ status: "past_due", accessEndsAt: NOV25.toISOString() }))!.tone).toBe("warn");
    expect(billingStatusNote(view({ status: "canceled", endedAt: NOV25.toISOString() }))!.text).toBe("Your Pro subscription ended on Nov 25, 2026. Your data is kept; Free limits apply.");
  });
});

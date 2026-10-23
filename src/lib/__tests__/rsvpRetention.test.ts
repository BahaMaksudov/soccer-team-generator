import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { retentionCutoff, RSVP_RETENTION_DAYS } from "@/lib/rsvpRetention";

/** M13B P7 — retention cutoff (UTC) and policy source guards. */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = () =>
  walk(path.join(process.cwd(), "src"))
    .map((f) => path.relative(process.cwd(), f))
    .filter((f) => /\.(tsx?)$/.test(f) && !/__tests__|\.test\.tsx?$|\.itest\.ts$/.test(f));

describe("retention cutoff", () => {
  it("90 days, UTC calendar days, independent of the time of day", () => {
    expect(RSVP_RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(new Date("2026-10-23T00:00:00Z")).toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(retentionCutoff(new Date("2026-10-23T23:59:59.999Z")).toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(retentionCutoff(new Date("2027-01-01T05:00:00Z")).toISOString()).toBe("2026-10-03T00:00:00.000Z"); // across the year
    expect(retentionCutoff(new Date("2028-05-29T12:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z"); // leap day
  });
  it("cleanup is not scheduled anywhere (no route, cron or page imports it)", () => {
    expect(sources().filter((f) => f !== "src/lib/rsvpRetention.ts" && /@\/lib\/rsvpRetention/.test(read(f)))).toEqual([]);
  });
});

describe("suppression policy guards", () => {
  it("no organizer path can delete an opt-out or a suppression (only the support erasure function, and never a bounce / complaint)", () => {
    const deleters = sources().filter((f) => /(organizationEmailOptOut|globalEmailSuppression)\.(delete|deleteMany)\(/.test(read(f)));
    expect(deleters).toEqual(["src/lib/rsvpRetention.ts"]);
    const erase = read("src/lib/rsvpRetention.ts");
    expect(erase).toContain('existing?.reason === "RECIPIENT_REQUEST"');
  });
  it("account and security emails never consult suppression or carry unsubscribe headers", () => {
    const idx = read("src/lib/email/index.ts");
    expect(idx).not.toMatch(/List-Unsubscribe|suppressedFor|emailSuppression|rsvp/i);
  });
});

describe("guardian authorization wording", () => {
  it("the UI and emails never claim a parent / guardian's consent was verified", () => {
    for (const f of ["src/app/admin/o/[organizationSlug]/g/[groupSlug]/PlayerContactCell.tsx", "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/RsvpPreviewCard.tsx", "src/lib/email/templates.ts", "src/lib/playerContact.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/consent (was |has been |is )?(verified|confirmed|obtained)|verified (parental |guardian )?consent|parental consent (verified|confirmed|obtained)/i);
    }
    const cell = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/PlayerContactCell.tsx");
    expect(cell).toContain("It isn&apos;t verified and isn&apos;t a legal consent record.");
  });
});

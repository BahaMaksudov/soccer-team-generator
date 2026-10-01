import { describe, it, expect } from "vitest";
import { createWorkspaceSchema, isValidTimeZone, nextAvailableSlug, slugify } from "@/lib/workspaces";

describe("slugify", () => {
  it.each([
    ["New England Eagles", "new-england-eagles"],
    ["Boston Pickup Soccer", "boston-pickup-soccer"],
    ["  Café  Fútbol!! ", "cafe-futbol"],
    ["A/B & C", "a-b-c"],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("workspace");
    expect(slugify("日本", "organization")).toBe("organization");
  });

  it("caps length without a trailing dash", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("nextAvailableSlug", () => {
  it("uses the base when free, otherwise the first free numeric suffix", () => {
    expect(nextAvailableSlug("boston-pickup-soccer", [])).toBe("boston-pickup-soccer");
    expect(nextAvailableSlug("boston-pickup-soccer", ["boston-pickup-soccer"])).toBe("boston-pickup-soccer-2");
    expect(nextAvailableSlug("x", ["x", "x-2", "x-4"])).toBe("x-3");
  });
});

describe("createWorkspaceSchema", () => {
  const ok = { organizationName: "Boston Pickup Soccer", groupName: "Wednesday Night", sportKey: "soccer", timezone: "America/New_York" };

  it("accepts a valid request and strips client-supplied ownership fields", () => {
    const parsed = createWorkspaceSchema.parse({ ...ok, userId: "someone-else", organizationId: "org-x", role: "OWNER" });
    expect(parsed).toEqual(ok);
  });

  it("M7: every registry sport is accepted; arbitrary sport strings are rejected", () => {
    for (const sportKey of ["soccer", "basketball", "volleyball", "flag_football", "other"]) {
      expect(createWorkspaceSchema.safeParse({ ...ok, sportKey }).success).toBe(true);
    }
    for (const sportKey of ["american_football", "hockey", "Soccer", "", "soccer "]) {
      expect(createWorkspaceSchema.safeParse({ ...ok, sportKey }).success).toBe(false);
    }
  });

  it("requires a real IANA timezone", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(createWorkspaceSchema.safeParse({ ...ok, timezone: "Mars/Olympus" }).success).toBe(false);
  });

  it("requires names", () => {
    expect(createWorkspaceSchema.safeParse({ ...ok, organizationName: " " }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ ...ok, groupName: "" }).success).toBe(false);
  });
});

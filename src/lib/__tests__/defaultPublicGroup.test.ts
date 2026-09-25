import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDefaultPublicGroupSlugs } from "../defaultPublicGroup";

const ORG_KEY = "DEFAULT_PUBLIC_ORGANIZATION_SLUG";
const GROUP_KEY = "DEFAULT_PUBLIC_GROUP_SLUG";

const originalOrg = process.env[ORG_KEY];
const originalGroup = process.env[GROUP_KEY];

beforeEach(() => {
  delete process.env[ORG_KEY];
  delete process.env[GROUP_KEY];
});

afterEach(() => {
  if (originalOrg === undefined) delete process.env[ORG_KEY];
  else process.env[ORG_KEY] = originalOrg;
  if (originalGroup === undefined) delete process.env[GROUP_KEY];
  else process.env[GROUP_KEY] = originalGroup;
});

describe("getDefaultPublicGroupSlugs", () => {
  it("returns both slugs when both are configured", () => {
    process.env[ORG_KEY] = "new-england-eagles";
    process.env[GROUP_KEY] = "indoor-soccer";

    expect(getDefaultPublicGroupSlugs()).toEqual({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });
  });

  it("trims whitespace", () => {
    process.env[ORG_KEY] = "  new-england-eagles  ";
    process.env[GROUP_KEY] = "  indoor-soccer  ";

    expect(getDefaultPublicGroupSlugs()).toEqual({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });
  });

  it("fails closed (null) when the organization slug is missing", () => {
    process.env[GROUP_KEY] = "indoor-soccer";
    expect(getDefaultPublicGroupSlugs()).toBeNull();
  });

  it("fails closed (null) when the group slug is missing", () => {
    process.env[ORG_KEY] = "new-england-eagles";
    expect(getDefaultPublicGroupSlugs()).toBeNull();
  });

  it("fails closed (null) when both are missing", () => {
    expect(getDefaultPublicGroupSlugs()).toBeNull();
  });

  it("fails closed (null) when either value is empty or only whitespace", () => {
    process.env[ORG_KEY] = "   ";
    process.env[GROUP_KEY] = "indoor-soccer";
    expect(getDefaultPublicGroupSlugs()).toBeNull();

    process.env[ORG_KEY] = "new-england-eagles";
    process.env[GROUP_KEY] = "";
    expect(getDefaultPublicGroupSlugs()).toBeNull();
  });
});

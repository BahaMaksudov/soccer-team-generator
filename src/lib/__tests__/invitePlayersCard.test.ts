import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * M13A hardening — replacing an ACTIVE invite link needs the organizer's explicit
 * confirmation (the server refuses without `replace: true` too — m13a.itest.ts).
 */
const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/players/InvitePlayersCard.tsx"), "utf8");

describe("Invite players card — replacement confirmation", () => {
  it("with an active link, 'Generate new link' only opens the confirmation; nothing is revoked yet", () => {
    expect(src).toContain('onClick={() => (active ? setConfirmReplace(true) : generate(false))}');
  });
  it("the confirmation explains that the previously shared link stops working, and only 'Replace link' sends replace: true", () => {
    expect(src).toContain("Replace the invite link?");
    expect(src).toContain("The link you shared before will stop working");
    expect(src).toContain('onClick={() => generate(true)}');
    expect(src.split("generate(true)").length - 1).toBe(1);
    expect(src).toContain('...(replace ? { replace: true } : {})');
    expect(src).toContain("Keep current link");
  });
});

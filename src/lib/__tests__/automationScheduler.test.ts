import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * M9.2 — the Production scheduler: a GitHub Actions workflow that is only a
 * clock, and the protected endpoint it calls. Static checks of the workflow
 * file + the endpoint's auth / failure responses with the engine stubbed (no
 * database, no network, fake secrets only).
 */
const runMatchAutomation = vi.fn();
vi.mock("@/lib/matchAutomation", () => ({ runMatchAutomation: (...args: unknown[]) => runMatchAutomation(...args) }));
import { POST } from "@/app/api/cron/automation/route";
import * as cronRoute from "@/app/api/cron/automation/route";
import { authorizeCron } from "@/lib/cronAuth";

const WORKFLOW = path.join(process.cwd(), ".github/workflows/match-automation.yml");
const yml = fs.readFileSync(WORKFLOW, "utf8");
const code = yml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("GitHub Actions scheduler workflow", () => {
  it("exists and is the only workflow that calls the automation endpoint", () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
    const dir = path.dirname(WORKFLOW);
    const callers = fs.readdirSync(dir).filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("/api/cron/automation"));
    expect(callers).toEqual(["match-automation.yml"]);
  });

  it("runs every 15 minutes and on manual dispatch — never on pushes or pull requests", () => {
    expect(code).toMatch(/^on:\n  schedule:\n    - cron: "\*\/15 \* \* \* \*"\n  workflow_dispatch:\n\n/m);
    expect(code).not.toMatch(/^\s*(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m);
    expect(code).not.toMatch(/workflow_dispatch:\n\s+inputs:/); // nothing can be passed in to redirect it
  });

  it("targets exactly the Production endpoint (no Preview, localhost or derived URL) with POST", () => {
    const urls = code.match(/https?:\/\/[^\s"']+/g);
    expect(urls).toEqual(["https://teambalancepro.com/api/cron/automation"]);
    expect(code).toContain("ENDPOINT: https://teambalancepro.com/api/cron/automation");
    expect(code).not.toMatch(/localhost|vercel\.app|127\.0\.0\.1|github\.head_ref|github\.event\.inputs|inputs\./);
    expect(code).toContain("--request POST");
  });

  it("only runs for main of this repository", () => {
    expect(code).toContain("if: github.repository == 'BahaMaksudov/soccer-team-generator' && github.ref == 'refs/heads/main'");
  });

  it("takes the secret from GitHub Secrets only; no secret is committed or printed", () => {
    expect(code).toContain("TBP_CRON_SECRET: ${{ secrets.TBP_CRON_SECRET }}");
    expect(code.match(/secrets\.\w+/g)).toEqual(["secrets.TBP_CRON_SECRET"]);
    expect(code).not.toMatch(/Bearer [A-Za-z0-9_\-]{8,}/); // no literal token
    expect(code).not.toMatch(/set -x|--verbose|\s-v\s|--trace/);
    expect(code).not.toMatch(/echo[^\n]*(TBP_CRON_SECRET\}|Authorization)/);
    // The header reaches curl on stdin, not on its command line.
    expect(code).toContain(`printf 'header = "Authorization: Bearer %s"\\n' "\${TBP_CRON_SECRET}" | curl`);
    expect(code).toContain("--config -");
    expect(code).not.toMatch(/\?(secret|token)=/);
    expect(code).toContain("permissions: {}");
  });

  it("fails the run visibly on connection errors, non-2xx and a reported automation failure", () => {
    expect(code).toContain("set -euo pipefail");
    expect(code).toContain("--fail-with-body");
    expect(code).toContain("--show-error");
    expect(code).toMatch(/if \[ "\$\{status\}" -ne 0 \]; then[\s\S]*?exit "\$\{status\}"/);
    expect(code).toMatch(/jq -e '\.ok == true' response\.json[\s\S]*?exit 1/);
    expect(code).toMatch(/if \[ -z "\$\{TBP_CRON_SECRET\}" \]; then[\s\S]*?exit 1/);
    expect(code).toMatch(/timeout-minutes: \d+/);
  });
});

describe("cron endpoint", () => {
  const SECRET = "fake-secret-for-unit-tests-0123456789";
  const req = (auth?: string) => new Request("https://example.test/api/cron/automation", { method: "POST", headers: auth ? { authorization: auth } : {} });
  const logs: string[] = [];
  beforeEach(() => {
    runMatchAutomation.mockReset();
    logs.length = 0;
    for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const run = { schedules: 1, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, errors: [] };

  it("is POST only", () => {
    expect(Object.keys(cronRoute).filter((k) => /^(GET|PUT|PATCH|DELETE|HEAD)$/.test(k))).toEqual([]);
  });

  it("no CRON_SECRET → 503; too short a secret counts as not configured; nothing runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(req(`Bearer ${SECRET}`))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await POST(req("Bearer short"))).status).toBe(503);
    expect(runMatchAutomation).not.toHaveBeenCalled();
  });

  it("missing / wrong / non-Bearer authorization → 401; nothing runs", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const auth of [undefined, "Bearer wrong-secret-value-xxxxxxxx", SECRET, `Basic ${SECRET}`, `Bearer ${SECRET}x`, "Bearer "]) expect((await POST(req(auth))).status, String(auth)).toBe(401);
    expect(authorizeCron(new Request(`https://example.test/api/cron/automation?secret=${SECRET}`), { CRON_SECRET: SECRET })).toBe("unauthorized");
    expect(runMatchAutomation).not.toHaveBeenCalled();
  });

  it("correct secret → runs the engine once and returns counts; the secret never appears in the body or logs", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    runMatchAutomation.mockResolvedValue({ ...run, created: 1, pollsPosted: 1 });
    const res = await POST(req(`Bearer ${SECRET}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, schedules: 1, created: 1, pollsPosted: 1, cutoffs: 0, notified: 0, errorCount: 0 });
    expect(runMatchAutomation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body) + logs.join("\n")).not.toContain(SECRET);
  });

  it("a run that reports failures → 500 (the workflow fails); error details only in the server log", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    runMatchAutomation.mockResolvedValue({ ...run, errors: [{ matchId: "m1", error: "boom" }] });
    const res = await POST(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, errorCount: 1 });
    expect(JSON.stringify(body)).not.toContain("boom");
    expect(logs.join("\n")).toContain("boom");
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("an engine exception → 500 with a generic body", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    runMatchAutomation.mockRejectedValue(new Error("database unreachable"));
    const res = await POST(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Automation run failed." });
  });
});

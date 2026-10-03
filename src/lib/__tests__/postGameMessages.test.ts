import { describe, it, expect } from "vitest";
import { outcomeLine, renderResultMessage, renderSummaryMessage, scoreboardLines, SUMMARY_TEXT_BUDGET, TELEGRAM_TEXT_LIMIT } from "@/lib/messaging/postGameMessages";
import { sportMessaging } from "@/lib/sports";

/** M9-D — Telegram scoreboard result + combined Match Summary (published data only). */

const SOCCER = { date: "2026-10-05", sportEmoji: sportMessaging("soccer").emoji, scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }], venue: "Forekicks" };
const RECAP = "Team 1 takes it over Team 2, 5–3—a two-goal win at Forekicks! ⚽ Player of the Match honors go to Yasmina A! 🏆";
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

describe("Final result scoreboard", () => {
  it("1/4/24: two teams → one head-to-head line; winner; venue; canonical link", () => {
    const m = renderResultMessage(SOCCER, "https://teambalancepro.com/g/o/g/m/abc");
    expect(m.html).toBe(
      [
        "<b>🏁 FINAL SCORE — 10/5/26</b>",
        "",
        "⚽ Team 1  5 — 3  Team 2",
        "",
        "🏆 Team 1 wins!",
        "📍 Forekicks",
        "",
        '<a href="https://teambalancepro.com/g/o/g/m/abc">View match</a>',
      ].join("\n")
    );
    expect(m.html).not.toMatch(/•|Score\n/); // no longer a bullet list
  });
  it("2: draw", () => {
    const m = renderResultMessage({ ...SOCCER, scores: [{ teamNumber: 1, score: 4 }, { teamNumber: 2, score: 4 }] }, null);
    expect(plain(m.html)).toBe("🏁 FINAL SCORE — 10/5/26\n\n⚽ Team 1  4 — 4  Team 2\n\n🤝 Draw\n📍 Forekicks");
  });
  it("3: more than two teams → standings (highest first), no head-to-head line; tie at the top is a draw", () => {
    const three = [{ teamNumber: 1, score: 6 }, { teamNumber: 2, score: 8 }, { teamNumber: 3, score: 4 }];
    expect(scoreboardLines("⚽", three)).toEqual(["Team 2 — 8", "Team 1 — 6", "Team 3 — 4"]);
    expect(outcomeLine(three)).toBe("🏆 Team 2 wins!");
    expect(outcomeLine([{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 3 }, { teamNumber: 3, score: 1 }])).toBe("🤝 Draw");
    expect(plain(renderResultMessage({ ...SOCCER, venue: null, scores: three }, null).html)).toBe("🏁 FINAL SCORE — 10/5/26\n\nTeam 2 — 8\nTeam 1 — 6\nTeam 3 — 4\n\n🏆 Team 2 wins!");
  });
  it("sport emoji comes from the sport registry; no venue → no venue line; no link (PRIVATE) → no link", () => {
    const m = renderResultMessage({ ...SOCCER, sportEmoji: sportMessaging("basketball").emoji, venue: null, scores: [{ teamNumber: 1, score: 72 }, { teamNumber: 2, score: 68 }] }, null);
    expect(m.html).toContain("🏀 Team 1  72 — 68  Team 2");
    expect(m.html).not.toMatch(/⚽|📍|<a /);
  });
  it("markup is escaped (venue/link)", () => {
    const m = renderResultMessage({ ...SOCCER, venue: "<b>Fore & kicks</b>" }, 'https://x.test/m/1?a="b"');
    expect(m.html).toContain("📍 &lt;b&gt;Fore &amp; kicks&lt;/b&gt;");
    expect(m.html).toContain('href="https://x.test/m/1?a=&quot;b&quot;"');
  });
  it("the content hash is from published data — not the link or the wording", () => {
    const a = renderResultMessage(SOCCER, "https://x.test/share/m/1#token-one");
    const b = renderResultMessage(SOCCER, null);
    expect(a.contentHash).toBe(b.contentHash);
    expect(renderResultMessage({ ...SOCCER, scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 4 }] }, null).contentHash).not.toBe(a.contentHash);
  });
});

describe("Combined Match Summary", () => {
  const sum = (o: { mvpNames?: string[]; recap?: string | null }, url: string | null = null) => renderSummaryMessage({ ...SOCCER, mvpNames: o.mvpNames ?? [], recap: o.recap ?? null }, url);

  it("6: result only", () => {
    expect(plain(sum({}).html)).toBe("🏁 MATCH COMPLETE — 10/5/26\n\n⚽ Team 1  5 — 3  Team 2\n🏆 Team 1 wins!\n\n📍 Forekicks");
  });
  it("7/8/9: + Player of the Match / + recap / both, in the defined order", () => {
    expect(plain(sum({ mvpNames: ["Yasmina A"] }).html)).toBe("🏁 MATCH COMPLETE — 10/5/26\n\n⚽ Team 1  5 — 3  Team 2\n🏆 Team 1 wins!\n\n⭐ Player of the Match\nYasmina A\n\n📍 Forekicks");
    expect(plain(sum({ recap: RECAP }).html)).toBe(`🏁 MATCH COMPLETE — 10/5/26\n\n⚽ Team 1  5 — 3  Team 2\n🏆 Team 1 wins!\n\n📝 Match Recap\n${RECAP}\n\n📍 Forekicks`);
    const all = sum({ mvpNames: ["Yasmina A"], recap: RECAP }, "https://teambalancepro.com/g/o/g/m/abc");
    const text = plain(all.html);
    const order = ["MATCH COMPLETE", "Team 1  5 — 3  Team 2", "Team 1 wins!", "Player of the Match", "Yasmina A", "Match Recap", RECAP, "📍 Forekicks", "View match"].map((x) => text.indexOf(x));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(plain(sum({ mvpNames: ["A", "B"] }).html)).toContain("⭐ Players of the Match\nA\nB");
  });
  it("16: any published change (result, MVP, recap) changes the summary hash; the link does not", () => {
    const base = sum({ mvpNames: ["Yasmina A"], recap: RECAP });
    expect(sum({ mvpNames: ["Yasmina A"], recap: RECAP }, "https://x.test/share/m/1#t").contentHash).toBe(base.contentHash);
    expect(sum({ mvpNames: ["Someone Else"], recap: RECAP }).contentHash).not.toBe(base.contentHash);
    expect(sum({ mvpNames: ["Yasmina A"], recap: `${RECAP} Edited.` }).contentHash).not.toBe(base.contentHash);
    expect(sum({ mvpNames: ["Yasmina A"] }).contentHash).not.toBe(base.contentHash);
    expect(renderSummaryMessage({ ...SOCCER, scores: [{ teamNumber: 1, score: 6 }, { teamNumber: 2, score: 3 }], mvpNames: ["Yasmina A"], recap: RECAP }, null).contentHash).not.toBe(base.contentHash);
  });
  it("21: an oversized recap is shortened (only the recap) so the message stays under Telegram's limit; score, outcome, MVP and link stay intact", () => {
    const huge = "Great game! ".repeat(600); // ~7,200 characters
    const m = sum({ mvpNames: ["Yasmina A"], recap: huge }, "https://teambalancepro.com/g/o/g/m/abc");
    expect(m.plainLength).toBeLessThanOrEqual(SUMMARY_TEXT_BUDGET);
    expect(plain(m.html).length).toBeLessThan(TELEGRAM_TEXT_LIMIT);
    for (const must of ["⚽ Team 1  5 — 3  Team 2", "🏆 Team 1 wins!", "Yasmina A", "📍 Forekicks", 'href="https://teambalancepro.com/g/o/g/m/abc"']) expect(m.html).toContain(must);
    expect(m.html).toContain("…");
    expect(m.html.match(/<b>/g)?.length).toBe(m.html.match(/<\/b>/g)?.length); // markup stays balanced
    // The hash still reflects the full published recap, not the shortened text.
    expect(m.contentHash).toBe(sum({ mvpNames: ["Yasmina A"], recap: huge }).contentHash);
  });
  it("a normal (≤ 1,200-character) recap is never shortened", () => {
    const recap = "x".repeat(1200);
    expect(sum({ mvpNames: ["Yasmina A"], recap }, "https://teambalancepro.com/g/o/g/m/abc").html).toContain(recap);
  });
});

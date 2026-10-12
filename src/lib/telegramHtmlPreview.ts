/**
 * Manual Game Day Update — shows a Telegram HTML message (parse_mode "HTML", as
 * built by src/lib/messaging/gameDayUpdate.ts) in the browser WITHOUT injecting
 * HTML: the text is parsed into plain segments rendered as React text nodes.
 * Only <b>, <i> and <a href="https://…"> are recognised; any other tag is shown
 * literally, and a non-https link is shown as text without a link. Entities:
 * &amp; &lt; &gt; &quot; (the ones escapeHtml produces).
 */
export type PreviewSegment = { text: string; bold: boolean; italic: boolean; href: string | null };
export type PreviewLine = PreviewSegment[];

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function safeHref(raw: string): string | null {
  try {
    const u = new URL(decode(raw));
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const TAG = /<(\/?)(b|i|a)(?:\s+href="([^"]*)")?>/g;

export function parseTelegramHtml(html: string): PreviewLine[] {
  return html.split("\n").map((line) => {
    const out: PreviewSegment[] = [];
    let bold = 0;
    let italic = 0;
    let href: string | null = null;
    let inLink = false;
    let last = 0;
    const push = (text: string) => {
      if (text) out.push({ text: decode(text), bold: bold > 0, italic: italic > 0, href: inLink ? href : null });
    };
    for (const m of line.matchAll(TAG)) {
      const [whole, closing, tag, url] = m;
      const valid = tag === "a" ? (closing ? url === undefined : url !== undefined) : url === undefined;
      if (!valid) continue; // treated as literal text below
      push(line.slice(last, m.index));
      last = m.index! + whole.length;
      if (tag === "b") bold = Math.max(0, bold + (closing ? -1 : 1));
      else if (tag === "i") italic = Math.max(0, italic + (closing ? -1 : 1));
      else if (closing) {
        inLink = false;
        href = null;
      } else {
        inLink = true;
        href = safeHref(url!);
      }
    }
    push(line.slice(last));
    return out;
  });
}

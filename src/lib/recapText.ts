/**
 * M9.1 — THE recap text normalization, shared by the server (what save_recap
 * stores, via sanitizeRecapText in src/lib/recap.ts) and the organizer editor
 * (recapEditorState in src/lib/postGameUi.ts), so the editor's "unchanged"
 * means exactly "saving would store the same text". Pure; client-safe.
 *
 * Plain text only: tags and control characters removed, runs of spaces/tabs
 * collapsed, 3+ newlines collapsed to a blank line, trimmed.
 */
export function normalizeRecapText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

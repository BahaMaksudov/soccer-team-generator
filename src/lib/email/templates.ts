import type { OutgoingEmail } from "./transport";

/**
 * M5 — transactional email content. Plain text + simple HTML, all
 * dynamic values HTML-escaped. Contains no internal ids, passwords or
 * hashes — only the recipient-facing link.
 */
export const BRAND = "Team Balance Pro";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const formatDate = (d: Date) =>
  d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";

function layout(title: string, paragraphs: string[], action: { label: string; url: string }, footer: string): string {
  return [
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">`,
    `<h2 style="margin:0 0 16px">${escapeHtml(BRAND)}</h2>`,
    `<h3 style="margin:0 0 12px">${escapeHtml(title)}</h3>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`),
    `<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>`,
    `<p style="margin:0 0 12px;font-size:13px;color:#555">Or copy this link into your browser:<br>${escapeHtml(action.url)}</p>`,
    `<p style="margin:16px 0 0;font-size:12px;color:#777">${escapeHtml(footer)}</p>`,
    `</div>`,
  ].join("");
}

export function buildVerificationEmail(params: { to: string; name: string | null; url: string; expiresAt: Date }): OutgoingEmail {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  const lines = [
    greeting,
    `Please confirm that this is your email address to finish setting up your ${BRAND} account.`,
    `This link expires on ${formatDate(params.expiresAt)} (24 hours after it was sent) and can be used once.`,
  ];
  const footer = `If you did not create a ${BRAND} account, you can ignore this email.`;
  return {
    to: params.to,
    subject: `Verify your email for ${BRAND}`,
    text: [...lines, "", `Verify your email: ${params.url}`, "", footer].join("\n"),
    html: layout("Verify your email", lines, { label: "Verify email", url: params.url }, footer),
  };
}

export function buildInvitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string | null;
  role: string;
  url: string;
  expiresAt: Date;
}): OutgoingEmail {
  const who = params.inviterName ? `${params.inviterName} invited you` : "You have been invited";
  const lines = [
    `${who} to join ${params.organizationName} on ${BRAND} as ${params.role}.`,
    `${BRAND} helps organizers manage players and generate balanced teams.`,
    `This invitation expires on ${formatDate(params.expiresAt)} and can be used once.`,
  ];
  const footer = `If you were not expecting this invitation, you can ignore this email.`;
  return {
    to: params.to,
    subject: `You're invited to join ${params.organizationName} on ${BRAND}`,
    text: [...lines, "", `Accept the invitation: ${params.url}`, "", footer].join("\n"),
    html: layout(`Join ${params.organizationName}`, lines, { label: "View invitation", url: params.url }, footer),
  };
}

/**
 * M9.2 — Match Automation: "attendance is ready" for organizers. Counts and
 * names of the Match's Community roster only; never ratings or identities.
 */
export function buildAttendanceReadyEmail(params: {
  to: string;
  groupName: string;
  communityName: string | null;
  matchLabel: string; // e.g. "Monday, October 12"
  counts: { PLAYING: number; MAYBE: number; NOT_PLAYING: number; NO_RESPONSE: number };
  rosterSize: number;
  pollNote: string | null;
  url: string;
  /** M9.3 — the players' Match Link (absolute), when match links are available. */
  matchLinkUrl?: string | null;
}): OutgoingEmail {
  const who = params.communityName ? `${params.groupName} — ${params.communityName}` : params.groupName;
  const lines = [
    `Attendance is ready for ${params.matchLabel} (${who}).`,
    `Playing: ${params.counts.PLAYING} · Maybe: ${params.counts.MAYBE} · Not playing: ${params.counts.NOT_PLAYING} · Not responded: ${params.counts.NO_RESPONSE} (roster ${params.rosterSize}).`,
    ...(params.pollNote ? [params.pollNote] : []),
    "Review the attendance, then generate and publish the teams. Teams are never published automatically.",
    ...(params.matchLinkUrl ? [`Players can still see the match and, after you publish, the teams on the match link: ${params.matchLinkUrl}`] : []),
  ];
  const footer = `You receive this because you are an organizer (owner or admin) of this group on ${BRAND}.`;
  return {
    to: params.to,
    subject: `Attendance ready — ${params.matchLabel} · ${who}`,
    text: [...lines, "", `Review match: ${params.url}`, "", footer].join("\n"),
    html: layout("Attendance is ready", lines, { label: "Review Match", url: params.url }, footer),
  };
}

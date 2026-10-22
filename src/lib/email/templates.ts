import type { OutgoingEmail } from "./transport";

/**
 * M5 — transactional email content. Plain text + simple HTML, all
 * dynamic values HTML-escaped. Contains no internal ids, passwords or
 * hashes — only the recipient-facing link.
 */
export const BRAND = "TeamBalance Pro";

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

/**
 * M11.3 — trial lifecycle (organization OWNERs). States facts only: when the
 * trial ends, what changes on Free, that nothing is deleted, and what the owner
 * can do now. Never promises a payment option that isn't available.
 */
export function buildTrialEmail(params: {
  to: string;
  organizationName: string;
  stage: "REMINDER" | "EXPIRED";
  daysLeft: number | null;
  endsOn: string; // "Jan 7, 2027"
  upgradeLine: string;
  url: string;
}): OutgoingEmail {
  const freeChanges =
    "On the Free plan, Telegram attendance polls, team posts, match messages and Game Day Updates are turned off, and Free limits apply (1 active group, 30 active players, 4 new matches per month). Players can still answer through the match link.";
  const kept = "Nothing is deleted: players, communities, matches, attendance, teams, history and your connected Telegram groups are all kept.";
  const when = params.daysLeft === 1 ? "in less than a day" : `in ${params.daysLeft} days`;
  const lines =
    params.stage === "EXPIRED"
      ? [`The Pro trial of ${params.organizationName} ended on ${params.endsOn}. The organization is now on the Free plan.`, freeChanges, kept, params.upgradeLine]
      : [`The Pro trial of ${params.organizationName} ends ${when} (${params.endsOn}). Afterwards the Free plan applies automatically; nothing is charged.`, freeChanges, kept, params.upgradeLine];
  const subject =
    params.stage === "EXPIRED"
      ? `Your Pro trial has ended — ${params.organizationName}`
      : `Your Pro trial ends ${params.daysLeft === 1 ? "within a day" : `in ${params.daysLeft} days`} — ${params.organizationName}`;
  const footer = `You receive this because you own ${params.organizationName} on ${BRAND}.`;
  return {
    to: params.to,
    subject,
    text: [...lines, "", `Open your organization: ${params.url}`, "", footer].join("\n"),
    html: layout(params.stage === "EXPIRED" ? "Your Pro trial has ended" : "Your Pro trial is ending", lines, { label: "Open organization", url: params.url }, footer),
  };
}

/** M11.3 — password reset link (credentials accounts). */
export function buildPasswordResetEmail(params: { to: string; name: string | null; url: string; expiresAt: Date }): OutgoingEmail {
  const lines = [
    params.name ? `Hi ${params.name},` : "Hi,",
    `Someone asked to reset the password of your ${BRAND} account. Use the link below to choose a new password.`,
    `This link expires on ${formatDate(params.expiresAt)} (60 minutes after it was sent) and can be used once. Resetting signs you out everywhere else.`,
  ];
  const footer = `If you did not ask for this, you can ignore this email — your password stays the same.`;
  return {
    to: params.to,
    subject: `Reset your ${BRAND} password`,
    text: [...lines, "", `Reset your password: ${params.url}`, "", footer].join("\n"),
    html: layout("Reset your password", lines, { label: "Reset password", url: params.url }, footer),
  };
}

/** M11.3 — a reset was requested for an account that signs in with Google only (no password to reset). */
export function buildGoogleOnlyResetEmail(params: { to: string; name: string | null; url: string }): OutgoingEmail {
  const lines = [
    params.name ? `Hi ${params.name},` : "Hi,",
    `Someone asked to reset the password of your ${BRAND} account. Your account signs in with Google and has no password, so there is nothing to reset.`,
    `To sign in, choose "Continue with Google" on the sign-in page.`,
  ];
  const footer = `If you did not ask for this, you can ignore this email.`;
  return {
    to: params.to,
    subject: `Signing in to ${BRAND}`,
    text: [...lines, "", `Sign in: ${params.url}`, "", footer].join("\n"),
    html: layout("Sign in with Google", lines, { label: "Go to sign in", url: params.url }, footer),
  };
}

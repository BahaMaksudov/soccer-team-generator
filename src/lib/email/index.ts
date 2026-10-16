import { appUrl, getEmailFrom } from "./config";
import { getEmailTransport, type SendResult } from "./transport";
import { buildAttendanceReadyEmail, buildGoogleOnlyResetEmail, buildInvitationEmail, buildPasswordResetEmail, buildTrialEmail, buildVerificationEmail } from "./templates";
import { safeCallbackPath } from "@/lib/safeRedirect";

/**
 * M5 — the only email entry points used by services. Links are built
 * from APP_BASE_URL (never the request Host). Throws EmailConfigError /
 * EmailDeliveryError; callers decide the user-facing outcome.
 */

export async function sendVerificationEmail(params: {
  to: string;
  name: string | null;
  token: string;
  expiresAt: Date;
  /** Optional internal path to continue to after verifying (e.g. "/invite/…"). */
  next?: string | null;
}): Promise<SendResult> {
  const next = params.next ? safeCallbackPath(params.next, "") : "";
  const path = `/verify-email/${encodeURIComponent(params.token)}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const message = buildVerificationEmail({ to: params.to, name: params.name, url: appUrl(path), expiresAt: params.expiresAt });
  return getEmailTransport().send({ ...message, from: getEmailFrom() });
}

export async function sendInvitationEmail(params: {
  to: string;
  organizationName: string;
  inviterName: string | null;
  role: string;
  token: string;
  expiresAt: Date;
}): Promise<SendResult> {
  const message = buildInvitationEmail({
    to: params.to,
    organizationName: params.organizationName,
    inviterName: params.inviterName,
    role: params.role,
    url: appUrl(`/invite/${encodeURIComponent(params.token)}`),
    expiresAt: params.expiresAt,
  });
  return getEmailTransport().send({ ...message, from: getEmailFrom() });
}

/** M9.2 — Match Automation: attendance ready (one organizer per call). */
export async function sendAttendanceReadyEmail(params: Omit<Parameters<typeof buildAttendanceReadyEmail>[0], "url" | "matchLinkUrl"> & { matchPath: string; matchLinkPath?: string | null }): Promise<SendResult> {
  const { matchPath, matchLinkPath, ...rest } = params;
  const message = buildAttendanceReadyEmail({ ...rest, url: appUrl(matchPath), matchLinkUrl: matchLinkPath ? appUrl(matchLinkPath) : null });
  return getEmailTransport().send({ ...message, from: getEmailFrom() });
}

/** M11.3 — trial reminder / expiry (one OWNER per call); idempotent at the provider by `idempotencyKey`. */
export async function sendTrialEmail(params: Omit<Parameters<typeof buildTrialEmail>[0], "url"> & { path: string; idempotencyKey: string }): Promise<SendResult> {
  const { path, idempotencyKey, ...rest } = params;
  const message = buildTrialEmail({ ...rest, url: appUrl(path) });
  return getEmailTransport().send({ ...message, idempotencyKey, from: getEmailFrom() });
}

/** M11.3 — password reset link. */
export async function sendPasswordResetEmail(params: { to: string; name: string | null; token: string; expiresAt: Date }): Promise<SendResult> {
  const message = buildPasswordResetEmail({ to: params.to, name: params.name, url: appUrl(`/reset-password/${encodeURIComponent(params.token)}`), expiresAt: params.expiresAt });
  return getEmailTransport().send({ ...message, from: getEmailFrom() });
}

/** M11.3 — reset requested for a Google-only account: how to sign in instead. */
export async function sendGoogleOnlyResetEmail(params: { to: string; name: string | null }): Promise<SendResult> {
  const message = buildGoogleOnlyResetEmail({ ...params, url: appUrl("/login") });
  return getEmailTransport().send({ ...message, from: getEmailFrom() });
}

export { EmailConfigError } from "./config";
export { EmailDeliveryError } from "./transport";

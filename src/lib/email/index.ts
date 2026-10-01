import { appUrl, getEmailFrom } from "./config";
import { getEmailTransport, type SendResult } from "./transport";
import { buildInvitationEmail, buildVerificationEmail } from "./templates";
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

export { EmailConfigError } from "./config";
export { EmailDeliveryError } from "./transport";

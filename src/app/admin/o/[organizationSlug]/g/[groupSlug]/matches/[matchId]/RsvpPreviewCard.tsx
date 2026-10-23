"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Mail } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/game-day/parts";
import Dialog from "@/components/app/Dialog";
import { cn } from "@/lib/cn";

/**
 * M13B — RSVP email invitations for one match (OWNER/ADMIN; website-only matches).
 *   P2  recipient preview: who would get an email, masked destinations, why others are
 *       excluded, and the organization's ACTUAL remaining allowance (UTC day / month).
 *   P5  send flow: review → confirm the recipient count and that the organizer may
 *       contact these recipients for match coordination → submit with a stable,
 *       client-generated request key (a double click or retry returns the same send) →
 *       delivery dashboard. Delivery status and RSVP answers are shown SEPARATELY;
 *       "accepted" means accepted by the provider (here: the test outbox), not delivered.
 * The server decides whether sending is available (never in Production / Preview); the
 * button state only mirrors that. Hidden for Telegram matches with no email history.
 *   P6  per-recipient delivery details (contact type, masked address, timestamps, what
 *       each state means, later unsubscribes / bounces) and a confirmation DIALOG before
 *       every send, resend and retry.
 */
type Status = "WILL_SEND" | "NO_EMAIL" | "INVALID_CONTACT" | "CONTACT_UNCONFIRMED" | "IN_PROGRESS" | "ALREADY_ANSWERED" | "ORGANIZER_OVERRIDE" | "NOT_ON_ROSTER" | "SUPPRESSED" | "OVER_LIMIT";
type Row = { playerId: string; name: string; status: Status; source: "PLAYER" | "GUARDIAN" | "ACCOUNT" | null; maskedEmail: string | null };
type Window = { limit: number; used: number; reserved: number; remaining: number; resetsAt: string };
type Preview = {
  recipients: Row[];
  notOnRoster: Array<{ playerId: string; name: string }>;
  counts: { willSend: number; excluded: number };
  allowance: { plan: string; day: Window; month: Window; note: string };
  sending: { available: boolean };
};
type Delivery = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN" | "SKIPPED";
type Counts = Record<"queued" | "processing" | "accepted" | "failed" | "uncertain" | "skipped", number>;
type StatusView = {
  mode: "test-outbox" | "live" | "disabled";
  sends: Array<{ id: string; round: number; kind: "INITIAL" | "RESEND"; createdAt: string; counts: Counts; retryable: number }>;
  recipients: Array<{
    playerId: string | null;
    name: string;
    maskedEmail: string | null;
    recipientType: "PLAYER" | "GUARDIAN" | "ACCOUNT" | null;
    delivery: Delivery;
    skipReason: string | null;
    attempts: number;
    at: { queued: string | null; lastAttempt: string | null; accepted: string | null; failed: string | null };
    suppressedNow: boolean;
    rsvp: "PLAYING" | "MAYBE" | "NOT_PLAYING" | null;
    rsvpSetByOrganizer: boolean;
  }>;
  totals: { delivery: Counts; rsvp: { yes: number; maybe: number; no: number; unanswered: number }; inProgress: boolean; uncertain: number };
};

export const STATUS_LABEL: Record<Status, string> = {
  WILL_SEND: "Will be invited",
  NO_EMAIL: "No email address",
  INVALID_CONTACT: "Contact email needs fixing",
  CONTACT_UNCONFIRMED: "Contact email not confirmed",
  IN_PROGRESS: "Invitation already being sent",
  ALREADY_ANSWERED: "Already answered",
  ORGANIZER_OVERRIDE: "Status set by organizer",
  NOT_ON_ROSTER: "Not on this match's roster",
  SUPPRESSED: "Not receiving invitation emails",
  OVER_LIMIT: "Beyond remaining allowance",
};
const SOURCE_LABEL = { PLAYER: "Player", GUARDIAN: "Parent / Guardian", ACCOUNT: "Linked account (verified)" } as const;
/** Delivery labels — "accepted" is never called "delivered". */
export const deliveryLabel = (d: Delivery, mode: StatusView["mode"]): string =>
  ({ QUEUED: "Queued", SENDING: "Processing", SENT: mode === "test-outbox" ? "Accepted by test outbox" : "Accepted by email provider", FAILED: "Not sent (failed)", UNCERTAIN: "Delivery uncertain", SKIPPED: "Skipped" })[d];
const SKIP_LABEL: Record<string, string> = {
  ALREADY_ANSWERED: "already answered",
  ORGANIZER_OVERRIDE: "status set by organizer",
  NO_EMAIL: "no email address",
  INVALID_CONTACT: "contact email needs fixing",
  CONTACT_UNCONFIRMED: "contact email not confirmed",
  CONTACT_CHANGED: "contact email changed or removed before sending",
  IN_PROGRESS: "an earlier invitation was still being sent",
  SUPPRESSED: "unsubscribed or address suppressed",
  LIMIT: "over the allowance",
  PLAYER_REMOVED: "player removed",
  TELEGRAM_MATCH: "match moved to the Telegram poll",
  MATCH_CANCELED: "match canceled",
  MATCH_COMPLETED: "match completed",
  ATTENDANCE_CLOSED: "attendance closed",
  DEADLINE_PASSED: "deadline passed",
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
/** What each delivery state means for the organizer (accepted ≠ delivered). */
export function deliveryExplanation(x: StatusView["recipients"][number], mode: StatusView["mode"]): string {
  const by = mode === "test-outbox" ? "the test outbox" : "the email provider";
  switch (x.delivery) {
    case "QUEUED":
      return `Waiting to be sent (queued ${fmt(x.at.queued)}).`;
    case "SENDING":
      return `Being handed to ${by} (since ${fmt(x.at.lastAttempt)}).`;
    case "SENT":
      return `Accepted by ${by} ${fmt(x.at.accepted)}. That doesn't confirm it reached the inbox.`;
    case "FAILED":
      return `Not sent: ${by} rejected it (${fmt(x.at.failed)}). Nothing was delivered${x.attempts < 3 ? " — you can retry." : "; no retries left."}`;
    case "UNCERTAIN":
      return `${by[0].toUpperCase()}${by.slice(1)} didn't confirm (last attempt ${fmt(x.at.lastAttempt)}). It may or may not have arrived, so it isn't retried automatically.`;
    case "SKIPPED":
      return "Not sent.";
  }
}
const skipText = (reason: string | null) => (reason && SKIP_LABEL[reason] ? `Skipped — ${SKIP_LABEL[reason]}` : "Skipped");
const RSVP_LABEL = { PLAYING: "Yes", MAYBE: "Maybe", NOT_PLAYING: "No" } as const;
const newRequestKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

export default function RsvpPreviewCard({ organizationSlug, groupSlug, matchId }: { organizationSlug: string; groupSlug: string; matchId: string }) {
  const api = (p: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}/${p}` });
  const previewUrl = api("rsvp-preview");
  const sendUrl = api("rsvp-send");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<{ code: string; error: string } | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const requestKey = useRef<string>("");
  const [retryConfirm, setRetryConfirm] = useState<{ id: string; count: number } | null>(null);

  const loadPreview = useCallback(async () => {
    const res = await fetch(previewUrl, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setPreview(data as Preview);
      setRefusal(null);
    } else {
      setPreview(null);
      if (data?.code === "TELEGRAM_MATCH") setTelegram(true);
      setRefusal({ code: String(data?.code ?? "ERROR"), error: typeof data?.error === "string" ? data.error : "Could not load the preview." });
    }
  }, [previewUrl]);
  const loadStatus = useCallback(async () => {
    const res = await fetch(sendUrl, { cache: "no-store" });
    if (res.ok) setStatus((await res.json()) as StatusView);
  }, [sendUrl]);
  useEffect(() => {
    void loadPreview();
    void loadStatus();
  }, [loadPreview, loadStatus]);
  // Progress: poll while invitations are queued / processing.
  useEffect(() => {
    if (!status?.totals.inProgress) return;
    const id = window.setInterval(() => void loadStatus(), 3000);
    return () => window.clearInterval(id);
  }, [status?.totals.inProgress, loadStatus]);

  const hasSends = (status?.sends.length ?? 0) > 0;
  const kind: "INITIAL" | "RESEND" = hasSends ? "RESEND" : "INITIAL";
  const willSend = preview?.counts.willSend ?? 0;
  const available = Boolean(preview?.sending.available);

  function startConfirm() {
    requestKey.current = newRequestKey(); // one key per confirmation: double clicks / retries reuse it
    setAttested(false);
    setMessage(null);
    setConfirming(true);
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch(sendUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function send() {
    if (busy || !attested) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data } = await post({ action: "send", kind, requestKey: requestKey.current, expectedCount: willSend, attested: true });
      if (ok) {
        const counts = data.counts as { queued: number } | undefined;
        setConfirming(false);
        setMessage({ tone: "ok", text: `${counts?.queued ?? willSend} invitation${(counts?.queued ?? willSend) === 1 ? "" : "s"} queued.` });
      } else {
        setMessage({ tone: "warn", text: typeof data.error === "string" ? data.error : "Invitations could not be sent." });
        if (data.code !== "RATE_LIMITED") setConfirming(false); // the roster / match changed: review again
      }
    } catch {
      setMessage({ tone: "warn", text: "Invitations could not be sent. Please try again." }); // same request key on retry
    } finally {
      setBusy(false);
      void loadPreview();
      void loadStatus();
    }
  }

  async function retry(sendId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data } = await post({ action: "retry", sendId });
      setRetryConfirm(null);
      setMessage(ok ? { tone: "ok", text: `${data.requeued} failed invitation${data.requeued === 1 ? "" : "s"} queued again.` } : { tone: "warn", text: typeof data.error === "string" ? data.error : "Could not retry." });
    } finally {
      setBusy(false);
      void loadPreview();
      void loadStatus();
    }
  }

  if ((telegram && !hasSends) || (!preview && !refusal && !status)) return null;
  const latest = status?.sends[status.sends.length - 1];
  return (
    <SectionCard id="rsvp-preview" title="Email invitations" icon={<Mail className="size-5" />} meta="Invite players to RSVP by email. Each player gets their own link; their answer is saved only when they confirm it.">
      <div className="space-y-5">
        {status && hasSends && <Dashboard status={status} busy={busy} canRetry={available} onRetry={(id, count) => setRetryConfirm({ id, count })} retryId={latest?.id} />}

        {refusal ? (
          <p className="text-sm text-muted-foreground">{refusal.error}</p>
        ) : (
          preview && (
            <div className="space-y-4">
              {hasSends && <h3 className="text-sm font-bold">Resend to players who haven&apos;t answered</h3>}
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div className="rounded-tbp-md border border-border p-2">
                  <dt className="text-xs text-muted-foreground">{hasSends ? "Would be re-invited" : "Would be invited"}</dt>
                  <dd className="text-lg font-extrabold tabular-nums">{willSend}</dd>
                </div>
                <div className="rounded-tbp-md border border-border p-2">
                  <dt className="text-xs text-muted-foreground">Excluded</dt>
                  <dd className="text-lg font-extrabold tabular-nums">{preview.counts.excluded}</dd>
                </div>
                <AllowanceCell label="Remaining today (UTC)" w={preview.allowance.day} />
                <AllowanceCell label="Remaining this month (UTC)" w={preview.allowance.month} />
              </dl>
              <p className="text-xs text-muted-foreground">
                {preview.allowance.note} Who is invited is provisional until sending: answers, contact changes and unsubscribes are re-checked then.
              </p>
              <RecipientList rows={preview.recipients.filter((r) => r.status === "WILL_SEND")} title={`Will be ${hasSends ? "re-" : ""}invited (${willSend})`} open={!hasSends} />
              <RecipientList rows={preview.recipients.filter((r) => r.status !== "WILL_SEND")} title={`Excluded (${preview.counts.excluded})`} open={false} />
              {preview.notOnRoster.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-semibold">Not on this match&apos;s roster ({preview.notOnRoster.length}) — never invited</summary>
                  <p className="mt-1 text-xs text-muted-foreground">{preview.notOnRoster.map((p) => p.name).join(", ")}</p>
                </details>
              )}

              {!available ? (
                <div>
                  <Button type="button" disabled aria-disabled="true" title="Email sending isn't available yet">
                    Send invitations — coming soon
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">Email sending isn&apos;t available yet — nothing is sent from here.</p>
                </div>
              ) : (
                <Button type="button" disabled={willSend === 0 || busy} onClick={startConfirm}>
                  {hasSends ? `Resend to ${willSend} unanswered…` : `Send ${willSend} invitation${willSend === 1 ? "" : "s"}…`}
                </Button>
              )}
            </div>
          )
        )}
        <Dialog open={confirming} title={hasSends ? "Resend to unanswered players?" : "Send RSVP invitations?"} onClose={() => !busy && setConfirming(false)}>
          <div className="space-y-3" aria-label="Confirm sending">
            <p className="text-sm">
              {hasSends ? "Resend" : "Send"} an RSVP email to <span className="font-bold">{willSend}</span> recipient{willSend === 1 ? "" : "s"}
              {hasSends ? " who haven't answered" : ""}. Players who answered, were set by you, unsubscribed, or have an invitation still being sent are not included.
            </p>
            {hasSends && (status?.totals.uncertain ?? 0) > 0 && (
              <p className="rounded-tbp-md border border-amber-500/60 bg-amber-500/10 p-2 text-xs">Some earlier emails have an uncertain delivery. A resend may reach those players twice.</p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 size-5 shrink-0" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
              <span>I&apos;m authorized to contact these {willSend} recipients (players or their parents / guardians) about coordinating this match.</span>
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!attested || busy} onClick={send}>
                {busy ? "Sending…" : `${hasSends ? "Resend to" : "Send to"} ${willSend}`}
              </Button>
            </div>
          </div>
        </Dialog>
        <Dialog open={retryConfirm !== null} title="Retry failed emails?" onClose={() => !busy && setRetryConfirm(null)}>
          <p className="text-sm">
            Retry the {retryConfirm?.count ?? 0} email{retryConfirm?.count === 1 ? "" : "s"} the email service rejected. Each player is checked again first (answers, unsubscribes, roster, deadline and allowance). Uncertain emails are never retried.
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRetryConfirm(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => retryConfirm && retry(retryConfirm.id)}>
              {busy ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </Dialog>
        {message && (
          <p role="status" className={cn("text-sm font-semibold", message.tone === "ok" ? "text-primary" : "text-destructive")}>
            {message.text}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function AllowanceCell({ label, w }: { label: string; w: Window }) {
  return (
    <div className="rounded-tbp-md border border-border p-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-extrabold tabular-nums">
        {w.remaining}
        <span className="text-xs font-normal text-muted-foreground"> / {w.limit}</span>
      </dd>
      <dd className="text-xs text-muted-foreground">
        {w.used} used{w.reserved > 0 ? ` (${w.reserved} queued)` : ""}
      </dd>
    </div>
  );
}

function RecipientList({ rows, title, open }: { rows: Row[]; title: string; open: boolean }) {
  if (rows.length === 0) return null;
  return (
    <details className="text-sm" open={open}>
      <summary className="cursor-pointer font-semibold">{title}</summary>
      <ul className="mt-1 divide-y divide-border">
        {rows.map((r) => (
          <li key={r.playerId} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
            <span className="min-w-0">
              <span className="block break-words font-semibold">{r.name}</span>
              <span className="block break-all text-xs text-muted-foreground">{r.maskedEmail ?? "—"}</span>
              {r.source && <span className="block text-xs text-muted-foreground">{SOURCE_LABEL[r.source]}</span>}
            </span>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", r.status === "WILL_SEND" ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground")}>{STATUS_LABEL[r.status]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const CONTACT_LABEL = { PLAYER: "Player's email", GUARDIAN: "Parent / Guardian", ACCOUNT: "Linked account (verified)" } as const;

function Dashboard({ status, busy, canRetry, onRetry, retryId }: { status: StatusView; busy: boolean; canRetry: boolean; onRetry: (id: string, count: number) => void; retryId?: string }) {
  const d = status.totals.delivery;
  const r = status.totals.rsvp;
  const retryable = status.sends.find((s) => s.id === retryId)?.retryable ?? 0;
  const cell = (label: string, n: number, warn = false) => (
    <div className={cn("rounded-tbp-md border p-2", warn && n > 0 ? "border-amber-500/60 bg-amber-500/10" : "border-border")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-extrabold tabular-nums">{n}</dd>
    </div>
  );
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-bold">Email delivery{status.totals.inProgress ? " — sending…" : ""}</h3>
        <p className="text-xs text-muted-foreground">
          {status.mode === "test-outbox" ? "Test mode: emails go to the local test outbox only — nobody receives them." : "“Accepted” means the email provider accepted the message — not that it reached an inbox."}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {cell("Queued", d.queued)}
        {cell("Processing", d.processing)}
        {cell(status.mode === "test-outbox" ? "Accepted (test outbox)" : "Accepted by provider", d.accepted)}
        {cell("Failed", d.failed, true)}
        {cell("Uncertain", d.uncertain, true)}
        {cell("Skipped", d.skipped)}
      </dl>
      {status.totals.uncertain > 0 && (
        <p className="flex items-start gap-2 rounded-tbp-md border border-amber-500/60 bg-amber-500/10 p-2 text-sm" role="note">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {status.totals.uncertain} email{status.totals.uncertain === 1 ? "" : "s"} may or may not have been sent (the provider didn&apos;t confirm). They are not retried automatically, to avoid duplicates, and still count toward your allowance. Check with those
            players before resending.
          </span>
        </p>
      )}
      {retryable > 0 && canRetry && retryId && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => onRetry(retryId, retryable)}>
          Retry {retryable} failed…
        </Button>
      )}
      <div>
        <h3 className="text-sm font-bold">RSVP answers (invited players)</h3>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {cell("Yes", r.yes)}
          {cell("Maybe", r.maybe)}
          {cell("No", r.no)}
          {cell("Unanswered", r.unanswered)}
        </dl>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">Per player ({status.recipients.length})</summary>
        <ul className="mt-1 divide-y divide-border">
          {status.recipients.map((x, i) => (
            <li key={x.playerId ?? `removed-${i}`} className="space-y-1 py-2">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <span className="min-w-0">
                  <span className="block break-words font-semibold">{x.name}</span>
                  <span className="block break-all text-xs text-muted-foreground">
                    {x.maskedEmail ?? "—"}
                    {x.recipientType ? ` · ${CONTACT_LABEL[x.recipientType]}` : ""}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1 text-xs">
                  <span className={cn("rounded-full border px-2 py-0.5 font-semibold", x.delivery === "UNCERTAIN" || x.delivery === "FAILED" ? "border-amber-500/60 bg-amber-500/10" : "border-border bg-muted text-muted-foreground")}>{x.delivery === "SKIPPED" ? skipText(x.skipReason) : deliveryLabel(x.delivery, status.mode)}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 font-semibold">{x.rsvp ? `RSVP: ${RSVP_LABEL[x.rsvp]}${x.rsvpSetByOrganizer ? " (organizer)" : ""}` : "No answer yet"}</span>
                  {x.suppressedNow && <span className="rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 font-semibold">Suppressed</span>}
                </span>
              </div>
              {x.delivery !== "SKIPPED" && <p className="text-xs text-muted-foreground">{deliveryExplanation(x, status.mode)}</p>}
              {x.suppressedNow && x.delivery !== "SKIPPED" && <p className="text-xs text-muted-foreground">This address has since unsubscribed or bounced — it won&apos;t get further invitations.</p>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

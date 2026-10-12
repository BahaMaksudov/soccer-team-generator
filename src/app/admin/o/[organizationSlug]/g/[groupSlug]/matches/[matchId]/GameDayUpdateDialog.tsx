"use client";

import { useCallback, useEffect, useState } from "react";
import Dialog from "@/components/app/Dialog";
import { Button } from "@/components/ui/button";
import { StateChip } from "@/components/game-day/parts";
import { formatDeadline } from "@/lib/deadlineFormat";
import { parseTelegramHtml } from "@/lib/telegramHtmlPreview";
import type { GameDayPreview, WeatherReason } from "@/lib/gameDayUpdate";

/**
 * Manual "Send Game Day Update now" (OWNER/ADMIN). Opening it only PREVIEWS
 * (read-only): the organization and group, the ONE Telegram destination and the
 * attendance poll it replies to, the absolute deadline + time left, the exact
 * message, and a read-only kickoff weather check. Sending needs the explicit
 * confirmation checkbox and a fresh preview (it expires after 2 minutes); the
 * server re-checks everything and sends exactly the previewed text. An
 * uncertain send is never re-sent — the organizer can only mark it as sent
 * after finding it in the Telegram group. Never changes the automatic setting.
 */
const STATUS: Record<GameDayPreview["state"] | "JUST_SENT", { label: string; tone: "done" | "pending" | "neutral" | "warn" }> = {
  READY: { label: "Ready", tone: "pending" },
  JUST_SENT: { label: "Sent", tone: "done" },
  ALREADY_SENT: { label: "Already sent", tone: "done" },
  UNCERTAIN: { label: "Uncertain", tone: "warn" },
  SENDING: { label: "Sending…", tone: "neutral" },
  UNAVAILABLE: { label: "Unavailable", tone: "neutral" },
};

const WEATHER_REASON: Record<WeatherReason, string> = {
  INCLUDED: "Kickoff forecast found.",
  NO_VENUE: "No venue is set for this match, so there's no forecast.",
  NO_LOCATION: "The venue has no confirmed weather location (Group Settings → Venues).",
  NO_START_TIME: "The match has no start time, so there's no kickoff forecast.",
  NOT_CONFIGURED: "Weather forecasts aren't configured on this server.",
  OUT_OF_RANGE: "Kickoff is outside the forecast range (up to about 2 days ahead).",
  UNAVAILABLE: "The weather service didn't return a forecast for kickoff right now.",
};

export function TelegramMessagePreview({ html }: { html: string }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-lg border bg-card p-3 text-sm leading-relaxed" aria-label="Telegram message preview">
      {parseTelegramHtml(html).map((line, i) => (
        <div key={i} className="min-h-[1.25rem]">
          {line.map((s, j) => {
            const cls = [s.bold && "font-semibold", s.italic && "italic"].filter(Boolean).join(" ") || undefined;
            return s.href ? (
              <a key={j} className={`${cls ?? ""} text-primary underline`} href={s.href} target="_blank" rel="noopener noreferrer">
                {s.text}
              </a>
            ) : (
              <span key={j} className={cls}>
                {s.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function forecastText(f: NonNullable<GameDayPreview["weather"]["forecast"]>, units: "imperial" | "metric"): string {
  const parts: string[] = [];
  if (f.temperatureC !== null) parts.push(units === "imperial" ? `${Math.round((f.temperatureC * 9) / 5 + 32)}°F` : `${Math.round(f.temperatureC)}°C`);
  if (f.condition) parts.push(f.condition);
  if (f.rainChancePercent !== null) parts.push(`rain ${Math.round(f.rainChancePercent)}%`);
  if (f.windKph !== null) parts.push(units === "imperial" ? `wind ${Math.round(f.windKph / 1.609344)} mph` : `wind ${Math.round(f.windKph)} km/h`);
  return parts.join(" · ");
}

/** Stateless review panel (rendered by the dialog; also unit-tested on its own). */
export function GameDayUpdateReview({
  preview,
  timezone,
  justSent,
  confirmed,
  onConfirmedChange,
  secondsLeft,
  busy,
  feedback,
  markChecked,
  onMarkCheckedChange,
  onSend,
  onRefresh,
  onMarkSent,
}: {
  preview: GameDayPreview;
  timezone: string;
  justSent: boolean;
  confirmed: boolean;
  onConfirmedChange: (v: boolean) => void;
  /** Seconds until the preview expires (null when not READY). */
  secondsLeft: number | null;
  busy: boolean;
  feedback: string | null;
  markChecked: boolean;
  onMarkCheckedChange: (v: boolean) => void;
  onSend: () => void;
  onRefresh: () => void;
  onMarkSent: () => void;
}) {
  const status = STATUS[justSent ? "JUST_SENT" : preview.state];
  const chat = preview.destination?.chatTitle ?? null;
  const expired = preview.state === "READY" && secondsLeft !== null && secondsLeft <= 0;
  const canSend = preview.state === "READY" && !justSent && !expired && confirmed && !busy && Boolean(preview.token) && Boolean(chat);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <StateChip tone={status.tone}>{status.label}</StateChip>
        {!justSent && <span className={preview.state === "UNCERTAIN" ? "font-semibold text-destructive" : "text-muted-foreground"}>{preview.text}</span>}
      </div>
      {feedback && (
        <p role="status" className="rounded-md bg-muted p-2 text-sm">
          {feedback}
        </p>
      )}

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded-lg border p-3 text-xs">
        <dt className="text-muted-foreground">Organization</dt>
        <dd className="break-words font-semibold">{preview.organization}</dd>
        <dt className="text-muted-foreground">Group</dt>
        <dd className="break-words font-semibold">{preview.group}</dd>
        <dt className="text-muted-foreground">Telegram group</dt>
        <dd className="break-words font-semibold">{chat ?? "—"}</dd>
        <dt className="text-muted-foreground">Reply to poll</dt>
        <dd className="break-words">{preview.destination ? `“${preview.destination.pollQuestion}” (posted ${formatDeadline(preview.destination.pollPostedAt, timezone)})` : "—"}</dd>
        <dt className="text-muted-foreground">Attendance closes</dt>
        <dd>{preview.deadline ? `${formatDeadline(preview.deadline.at, timezone)} · ${preview.deadline.timeLeft === "closed" ? "closed" : `in ${preview.deadline.timeLeft}`}` : "No deadline"}</dd>
      </dl>

      {preview.message ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Message preview{preview.state === "READY" ? " — exactly what will be sent" : ""}</p>
          <TelegramMessagePreview html={preview.message.html} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No message preview (attendance has no open deadline).</p>
      )}

      <div className="rounded-lg border p-3 text-xs" aria-label="Weather check">
        <p className="font-semibold">Weather check (read-only)</p>
        <p>{preview.weather.forecast ? forecastText(preview.weather.forecast, preview.units) : WEATHER_REASON[preview.weather.reason]}</p>
        {preview.weather.forecast && !preview.weather.includedInMessage && <p className="text-muted-foreground">Not included in the message: weather is turned off in Group Settings → Game Day Update.</p>}
      </div>

      {!preview.automaticEnabled && <p className="text-xs text-muted-foreground">Automatic Game Day Updates stay off. Sending this one doesn&apos;t turn them on.</p>}

      {preview.sent && (
        <p className="text-xs">
          Sent{preview.sent.at ? ` ${formatDeadline(preview.sent.at, timezone)}` : ""}
          {preview.sent.by ? ` by ${preview.sent.by}` : ""}
          {preview.sent.markedSent ? " (marked as sent after checking Telegram)" : ""}. Only one Game Day Update is sent per match.
        </p>
      )}

      {preview.state === "READY" && !justSent && (
        <div className="space-y-2 border-t pt-3">
          {expired ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-destructive">This preview is out of date.</span>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRefresh}>
                Refresh preview
              </Button>
            </div>
          ) : (
            secondsLeft !== null && <p className="text-xs text-muted-foreground">Preview valid for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</p>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 size-4" checked={confirmed} disabled={busy || expired} onChange={(e) => onConfirmedChange(e.target.checked)} />
            <span>
              I checked the destination and the message. Send this Game Day Update to <span className="font-semibold">{chat}</span> now, as a reply to the attendance poll.
            </span>
          </label>
          <Button type="button" disabled={!canSend} onClick={onSend}>
            {busy ? "Sending…" : `Send to ${chat}`}
          </Button>
        </div>
      )}

      {preview.state === "UNCERTAIN" && preview.uncertainDeliveryId && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs">
            Open the Telegram group <span className="font-semibold">{chat ?? "of the attendance poll"}</span> and look for the Game Day Update. It is never re-sent automatically. If it&apos;s not there, leave it — nothing more will be sent for this match.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 size-4" checked={markChecked} disabled={busy} onChange={(e) => onMarkCheckedChange(e.target.checked)} />
            <span>I found this Game Day Update in the Telegram group.</span>
          </label>
          <Button type="button" variant="outline" size="sm" disabled={!markChecked || busy} onClick={onMarkSent}>
            Mark as sent
          </Button>
        </div>
      )}
    </div>
  );
}

export default function GameDayUpdateDialog({ open, onClose, api, timezone, onChanged }: { open: boolean; onClose: () => void; api: (path: string) => string; timezone: string; onChanged: () => void }) {
  const [preview, setPreview] = useState<GameDayPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [markChecked, setMarkChecked] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    setMarkChecked(false);
    try {
      const res = await fetch(api("/game-day-update/preview"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPreview(data.preview);
        setReceivedAt(Date.now());
      }
      else setError(data?.error ?? "The preview couldn't be loaded.");
    } finally {
      setNow(Date.now());
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setFeedback(null);
    setJustSent(false);
    load();
  }, [open, load]);

  useEffect(() => {
    if (!open || preview?.state !== "READY") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, preview?.state]);

  async function post(path: string, body: unknown) {
    const res = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { result?: string; error?: string } };
  }

  async function send() {
    if (!preview?.token) return;
    setBusy(true);
    setFeedback(null);
    let r: Awaited<ReturnType<typeof post>>;
    try {
      r = await post("/game-day-update/send", { token: preview.token });
    } finally {
      setBusy(false);
    }
    if (r.ok && r.data.result === "sent") {
      setJustSent(true);
      setFeedback("Game Day Update sent to Telegram.");
    } else {
      setFeedback(r.data.error ?? "Something went wrong.");
    }
    await load(); // always re-read the server state (sent / uncertain / refreshed preview)
    onChanged();
  }

  async function markSent() {
    if (!preview?.uncertainDeliveryId) return;
    setBusy(true);
    try {
      const r = await post("/game-day-update/mark-sent", { deliveryId: preview.uncertainDeliveryId });
      setFeedback(r.ok ? "Marked as sent." : (r.data.error ?? "Something went wrong."));
    } finally {
      setBusy(false);
    }
    await load();
    onChanged();
  }

  // Counted from when THIS browser received the preview, 5 s earlier than the server (never "valid" here but stale there).
  const secondsLeft = preview?.expiresInSeconds ? Math.max(0, preview.expiresInSeconds - 5 - Math.floor((now - receivedAt) / 1000)) : null;
  return (
    <Dialog open={open} title="Send Game Day Update now" onClose={onClose}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !preview ? (
        <p className="text-sm text-muted-foreground">Loading preview…</p>
      ) : (
        <GameDayUpdateReview
          preview={preview}
          timezone={timezone}
          justSent={justSent}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
          secondsLeft={secondsLeft}
          busy={busy}
          feedback={feedback}
          markChecked={markChecked}
          onMarkCheckedChange={setMarkChecked}
          onSend={send}
          onRefresh={load}
          onMarkSent={markSent}
        />
      )}
    </Dialog>
  );
}

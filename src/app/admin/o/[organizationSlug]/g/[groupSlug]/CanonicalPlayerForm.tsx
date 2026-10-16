"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { ratingLabel } from "@/lib/labels";
import type { SportClientView } from "@/lib/sports";
import {
  PLAYER_RATINGS,
  STAMINA_OPTIONS,
  validatePlayerForm,
  type PlayerFormValues,
} from "@/lib/canonicalAdminState";

/**
 * Phase 2D.6D.5E.3 — one Player form for both Create and Edit in the
 * canonical workspace. Purely presentational + client-side validation;
 * the parent decides which canonical route to call. Exposes every
 * mutable Player field: first/last name, position, rating, stamina,
 * active.
 *
 * M7 — sport-aware: role options and the "Position"/"Role" label come
 * from the Group's SportDefinition (the server re-validates the role
 * against the Group's sport). Rating is shown as "Skill" (skill in this
 * Group's sport); stamina sits under "More" (optional, defaults to 3).
 *
 * M9.2 — optional Community memberships (multiple): only this Group's
 * Communities are offered; new memberships only in active ones (a current
 * membership in an inactive Community is shown and may be removed). Create
 * ("always") passes the chosen set; Edit ("whenChanged") passes it ONLY when
 * it differs from `initial` (undefined = leave memberships unchanged). The
 * server applies it atomically with the player write.
 */
export type PlayerFormCommunities = {
  options: Array<{ id: string; name: string; isActive: boolean }>;
  initial: string[];
  /** "always" (Create) or "whenChanged" (Edit: unchanged → memberships untouched). */
  submit: "always" | "whenChanged";
  /** Where Communities are created (shown when the Group has none). */
  settingsHref?: string;
};

export default function CanonicalPlayerForm({
  initial,
  sport,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
  communities,
}: {
  initial: PlayerFormValues;
  sport: SportClientView;
  submitLabel: string;
  busyLabel: string;
  /** Resolves to an error message (shown inline) or null on success. */
  onSubmit: (values: PlayerFormValues, communityIds?: string[]) => Promise<string | null>;
  onCancel?: () => void;
  communities?: PlayerFormCommunities;
}) {
  const [values, setValues] = useState<PlayerFormValues>(initial);
  const [chosen, setChosen] = useState<string[]>(communities?.initial ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  function set<K extends keyof PlayerFormValues>(key: K, value: PlayerFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = validatePlayerForm(
      values,
      sport.roles.map((r) => r.key),
      sport.terminology.roleNoun
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const changed = communities ? !(chosen.length === communities.initial.length && chosen.every((id) => communities.initial.includes(id))) : false;
      const err = await onSubmit(values, communities && (communities.submit === "always" || changed) ? chosen : undefined);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  }

  // UI-5 — redesigned presentation (same six fields, validation and request body).
  const control = "h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm";
  const labelCls = "mb-1 block text-sm font-semibold";
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`${uid}-first`}>First Name</label>
          <input id={`${uid}-first`} className={control} value={values.firstName} onChange={(e) => set("firstName", e.target.value)} autoComplete="off" required />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${uid}-last`}>Last Name</label>
          <input id={`${uid}-last`} className={control} value={values.lastName} onChange={(e) => set("lastName", e.target.value)} autoComplete="off" required />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${uid}-role`}>{sport.terminology.roleNoun}</label>
          <select id={`${uid}-role`} className={control} value={values.position} onChange={(e) => set("position", e.target.value)}>
            {/* A legacy/unknown stored role stays selectable so editing other fields never rewrites it. */}
            {!sport.roles.some((r) => r.key === values.position) && <option value={values.position}>{values.position}</option>}
            {sport.roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${uid}-skill`} title="This player's skill level in this group's sport">Skill</label>
          <select id={`${uid}-skill`} className={control} value={values.rating} onChange={(e) => set("rating", e.target.value as PlayerFormValues["rating"])}>
            {PLAYER_RATINGS.map((r) => (
              <option key={r} value={r}>
                {ratingLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${uid}-stamina`}>Stamina (1–5)</label>
          <select id={`${uid}-stamina`} aria-describedby={`${uid}-stamina-hint`} className={control} value={values.stamina} onChange={(e) => set("stamina", Number(e.target.value))}>
            {STAMINA_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <p id={`${uid}-stamina-hint`} className="mt-1 text-xs text-muted-foreground">1 = lower endurance · 5 = higher endurance. Used for balancing only.</p>
        </div>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
          <input type="checkbox" className="size-5 accent-primary" checked={values.isActive} onChange={(e) => set("isActive", e.target.checked)} />
          Active
        </label>
      </div>
      {communities && (
        <fieldset className="space-y-1">
          <legend className={labelCls}>Communities</legend>
          {communities.options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This group has no communities yet.
              {communities.settingsHref && (
                <>
                  {" "}
                  <Link className="font-semibold text-primary underline" href={communities.settingsHref}>
                    Create one in Group Settings
                  </Link>
                  .
                </>
              )}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Which rosters this player belongs to (any number). Attendance for a match counts its community&apos;s players.</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {communities.options
                  .filter((c) => c.isActive || communities.initial.includes(c.id))
                  .map((c) => {
                    const on = chosen.includes(c.id);
                    return (
                      <li key={c.id}>
                        <label className="flex min-h-9 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={on}
                            disabled={busy || (!c.isActive && !on)}
                            onChange={(e) => setChosen((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id)))}
                          />
                          <span className="min-w-0 break-words">
                            {c.name}
                            {c.isActive ? "" : " (inactive)"}
                          </span>
                        </label>
                      </li>
                    );
                  })}
              </ul>
            </>
          )}
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full border border-input bg-card px-5 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

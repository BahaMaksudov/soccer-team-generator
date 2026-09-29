"use client";

import { useState, type FormEvent } from "react";
import { positionLabel, ratingLabel } from "@/lib/labels";
import {
  PLAYER_POSITIONS,
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
 */
export default function CanonicalPlayerForm({
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  initial: PlayerFormValues;
  submitLabel: string;
  busyLabel: string;
  /** Resolves to an error message (shown inline) or null on success. */
  onSubmit: (values: PlayerFormValues) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<PlayerFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PlayerFormValues>(key: K, value: PlayerFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = validatePlayerForm(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const err = await onSubmit(values);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs">First Name</label>
          <input
            className="border rounded px-2 py-1 text-sm"
            value={values.firstName}
            onChange={(e) => set("firstName", e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs">Last Name</label>
          <input
            className="border rounded px-2 py-1 text-sm"
            value={values.lastName}
            onChange={(e) => set("lastName", e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs">Position</label>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={values.position}
            onChange={(e) => set("position", e.target.value as PlayerFormValues["position"])}
          >
            {PLAYER_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {positionLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs">Rating</label>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={values.rating}
            onChange={(e) => set("rating", e.target.value as PlayerFormValues["rating"])}
          >
            {PLAYER_RATINGS.map((r) => (
              <option key={r} value={r}>
                {ratingLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs">Stamina</label>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={values.stamina}
            onChange={(e) => set("stamina", Number(e.target.value))}
          >
            {STAMINA_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1 text-xs pb-1">
          <input type="checkbox" checked={values.isActive} onChange={(e) => set("isActive", e.target.checked)} />
          Active
        </label>
        <button
          type="submit"
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-60"
          disabled={busy}
        >
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="border rounded px-3 py-1 text-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {error && <div className="text-sm text-rose-700">{error}</div>}
    </form>
  );
}

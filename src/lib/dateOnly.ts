export function toDateOnlyUTC(input: string | Date) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return new Date(`${y}-${m}-${day}T00:00:00.000Z`);
}

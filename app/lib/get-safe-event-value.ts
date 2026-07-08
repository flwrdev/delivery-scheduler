// Polaris web components fire events whose value may live on currentTarget,
// target, or event.detail depending on the component — normalize all three.
// (Moved verbatim from app/routes/app.orders.tsx during the modal extraction.)
export function getSafeEventValue(e: Event): string {
  const t = (e.currentTarget ?? e.target) as
    | (EventTarget & { value?: unknown })
    | null;
  const detailValue = (e as Event & { detail?: { value?: unknown } }).detail
    ?.value;
  return (
    (typeof t?.value === "string" ? t.value : null) ??
    (typeof detailValue === "string" ? detailValue : null) ??
    ""
  );
}

import { useEffect, useState } from "preact/hooks";

import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LABEL,
  MAX_QUICK_REPLY_MESSAGE,
  validateQuickReplies,
} from "../../../../app/lib/quick-replies";
import { readQuickReplies, saveQuickReplies } from "../../../../app/services/quick-replies.server";
import { adminClient } from "../admin-client";

let nextDraftKey = 0;

function toDrafts(replies) {
  return replies.map((r) => ({ ...r, key: nextDraftKey++ }));
}

function sameReplies(a, b) {
  return (
    a.length === b.length &&
    a.every((r, i) => r.label === b[i].label && r.message === b[i].message)
  );
}

/** Edits the shop metafield $app.quick_replies used by the Orders page Reply modal. */
export function QuickRepliesSection() {
  const [saved, setSaved] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readQuickReplies(adminClient).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSaved(result.replies);
        setDrafts(toDrafts(result.replies));
        setLoadError(null);
      } else {
        setLoadError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = saved !== null && !sameReplies(saved, drafts);

  // Row indexes shift on move/delete, so stale per-row errors are cleared.
  const updateDrafts = (next) => {
    setDrafts(next);
    setFieldErrors({});
  };
  const editDraft = (index, patch) =>
    setDrafts((d) => d.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index, delta) => {
    const next = [...drafts];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    updateDrafts(next);
  };

  const save = async () => {
    const validation = validateQuickReplies(
      drafts.map(({ label, message }) => ({ label, message })),
    );
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      shopify.toast.show(validation.message, { isError: true });
      return;
    }
    setSaving(true);
    const result = await saveQuickReplies(adminClient, validation.replies);
    setSaving(false);
    if (result.ok) {
      setSaved(result.replies);
      setDrafts(toDrafts(result.replies));
      setFieldErrors({});
      shopify.toast.show("Quick replies saved");
    } else {
      shopify.toast.show(result.message, { isError: true });
    }
  };

  return (
    <s-section heading="Quick replies">
      <s-stack gap="base">
        <s-text color="subdued">
          Shown in the Reply window on the Orders page. One click adds the message.
        </s-text>

        {loadError && <s-banner tone="critical">{loadError}</s-banner>}
        {saved === null && !loadError && (
          <s-stack direction="inline" alignItems="center" gap="small">
            <s-spinner accessibilityLabel="Loading quick replies" />
            <s-text color="subdued">Loading quick replies…</s-text>
          </s-stack>
        )}
        {saved !== null && drafts.length === 0 && (
          <s-text color="subdued">No quick replies yet.</s-text>
        )}

        {drafts.map((reply, index) => (
          <s-box key={reply.key} padding="base" border="base" borderRadius="base">
            <s-stack gap="small">
              <s-text-field
                label="Label"
                value={reply.label}
                maxLength={MAX_QUICK_REPLY_LABEL}
                error={fieldErrors[index]?.label}
                disabled={saving}
                onInput={(e) => editDraft(index, { label: e.currentTarget.value })}
              />
              <s-text-area
                label="Message"
                rows={3}
                value={reply.message}
                maxLength={MAX_QUICK_REPLY_MESSAGE}
                error={fieldErrors[index]?.message}
                disabled={saving}
                onInput={(e) => editDraft(index, { message: e.currentTarget.value })}
              />
              <s-stack direction="inline" gap="small">
                <s-button
                  icon="arrow-up"
                  accessibilityLabel={`Move ${reply.label || "reply"} up`}
                  disabled={index === 0 || saving}
                  onClick={() => move(index, -1)}
                />
                <s-button
                  icon="arrow-down"
                  accessibilityLabel={`Move ${reply.label || "reply"} down`}
                  disabled={index === drafts.length - 1 || saving}
                  onClick={() => move(index, 1)}
                />
                <s-button
                  tone="critical"
                  disabled={saving}
                  onClick={() => updateDrafts(drafts.filter((_, i) => i !== index))}
                >
                  Delete
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        ))}

        {saved !== null && (
          <s-stack direction="inline" justifyContent="end" gap="small">
            <s-button
              disabled={drafts.length >= MAX_QUICK_REPLIES || saving}
              onClick={() => setDrafts((d) => [...d, ...toDrafts([{ label: "", message: "" }])])}
            >
              Add reply
            </s-button>
            <s-button variant="primary" loading={saving} disabled={!dirty || saving} onClick={save}>
              Save replies
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

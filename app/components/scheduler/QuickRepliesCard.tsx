import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LABEL,
  MAX_QUICK_REPLY_MESSAGE,
  type QuickReply,
  type QuickReplyFieldErrors,
} from "../../lib/quick-replies";
import type { QuickRepliesData } from "../../routes/app.scheduler_.quick-replies";

const QUICK_REPLIES_URL = "/app/scheduler/quick-replies";

// The key only gives React a stable identity while rows are moved or deleted.
interface DraftReply extends QuickReply {
  key: number;
}

let nextDraftKey = 0;

function toDrafts(replies: ReadonlyArray<QuickReply>): DraftReply[] {
  return replies.map((r) => ({ ...r, key: nextDraftKey++ }));
}

function sameReplies(a: ReadonlyArray<QuickReply>, b: ReadonlyArray<QuickReply>) {
  return (
    a.length === b.length &&
    a.every((r, i) => r.label === b[i].label && r.message === b[i].message)
  );
}

export function QuickRepliesCard() {
  const shopify = useAppBridge();
  const loadFetcher = useFetcher<QuickRepliesData>();
  const saveFetcher = useFetcher<QuickRepliesData>();
  const saving = saveFetcher.state !== "idle";

  const [saved, setSaved] = useState<QuickReply[] | null>(null);
  const [drafts, setDrafts] = useState<DraftReply[]>([]);
  const [fieldErrors, setFieldErrors] = useState<QuickReplyFieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = loadFetcher.load;
  useEffect(() => {
    load(QUICK_REPLIES_URL);
  }, [load]);

  useEffect(() => {
    const data = loadFetcher.data;
    if (!data || loadFetcher.state !== "idle") return;
    if (data.ok) {
      setSaved(data.replies);
      setDrafts(toDrafts(data.replies));
      setLoadError(null);
    } else {
      setLoadError(data.message);
    }
  }, [loadFetcher.data, loadFetcher.state]);

  const handledSaveRef = useRef<QuickRepliesData | null>(null);
  useEffect(() => {
    const data = saveFetcher.data;
    if (!data || saveFetcher.state !== "idle") return;
    if (handledSaveRef.current === data) return;
    handledSaveRef.current = data;
    if (data.ok) {
      setSaved(data.replies);
      setDrafts(toDrafts(data.replies));
      setFieldErrors({});
      shopify.toast.show("Quick replies saved");
    } else {
      setFieldErrors(data.fieldErrors ?? {});
      shopify.toast.show(data.message, { isError: true });
    }
  }, [saveFetcher.data, saveFetcher.state, shopify]);

  const dirty = saved !== null && !sameReplies(saved, drafts);

  // Row indexes shift on move/delete, so stale per-row errors are cleared.
  const updateDrafts = (next: DraftReply[]) => {
    setDrafts(next);
    setFieldErrors({});
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...drafts];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    updateDrafts(next);
  };

  const save = () => {
    saveFetcher.submit(
      { replies: drafts.map(({ label, message }) => ({ label, message })) },
      { method: "post", action: QUICK_REPLIES_URL, encType: "application/json" },
    );
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Quick replies
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Shown in the View email window on the Orders page. One click
              copies the message.
            </Text>
          </BlockStack>
          <Button
            disabled={saved === null || drafts.length >= MAX_QUICK_REPLIES || saving}
            onClick={() =>
              setDrafts((d) => [...d, ...toDrafts([{ label: "", message: "" }])])
            }
          >
            Add reply
          </Button>
        </InlineStack>

        {loadError && (
          <Banner tone="critical">
            <p>{loadError}</p>
          </Banner>
        )}

        {saved === null && !loadError && (
          <Text as="p" tone="subdued">
            Loading quick replies…
          </Text>
        )}

        {saved !== null && drafts.length === 0 && (
          <Text as="p" tone="subdued">
            No quick replies yet.
          </Text>
        )}

        {drafts.length > 0 && (
          <BlockStack gap="300">
            {drafts.map((reply, index) => (
              <BlockStack key={reply.key} gap="200">
                {index > 0 && <Divider />}
                <InlineStack align="space-between" blockAlign="end" gap="200">
                  <div style={{ minWidth: "200px", flexGrow: 1 }}>
                    <TextField
                      label="Label"
                      autoComplete="off"
                      value={reply.label}
                      maxLength={MAX_QUICK_REPLY_LABEL}
                      error={fieldErrors[index]?.label}
                      disabled={saving}
                      onChange={(label) =>
                        setDrafts((d) =>
                          d.map((r, i) => (i === index ? { ...r, label } : r)),
                        )
                      }
                    />
                  </div>
                  <ButtonGroup>
                    <Button
                      accessibilityLabel={`Move ${reply.label || "reply"} up`}
                      disabled={index === 0 || saving}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      accessibilityLabel={`Move ${reply.label || "reply"} down`}
                      disabled={index === drafts.length - 1 || saving}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      tone="critical"
                      disabled={saving}
                      onClick={() => updateDrafts(drafts.filter((_, i) => i !== index))}
                    >
                      Delete
                    </Button>
                  </ButtonGroup>
                </InlineStack>
                <TextField
                  label="Message"
                  autoComplete="off"
                  multiline={3}
                  value={reply.message}
                  maxLength={MAX_QUICK_REPLY_MESSAGE}
                  error={fieldErrors[index]?.message}
                  disabled={saving}
                  onChange={(message) =>
                    setDrafts((d) =>
                      d.map((r, i) => (i === index ? { ...r, message } : r)),
                    )
                  }
                />
              </BlockStack>
            ))}
          </BlockStack>
        )}

        {saved !== null && (
          <InlineStack align="end">
            <Button
              variant="primary"
              loading={saving}
              disabled={!dirty || saving}
              onClick={save}
            >
              Save replies
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

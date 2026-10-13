import { useEffect, useState } from "preact/hooks";

import { replySubject } from "../../../../app/lib/email-replies";
import { readQuickReplies } from "../../../../app/services/quick-replies.server";
import { adminClient } from "../admin-client";
import { loadOrderThread, sendOrderEmail } from "../email-client";
import { EmailText, whenLabel } from "./email-parts";

export const THREAD_MODAL_ID = "orders-email-thread-modal";
export const REPLY_MODAL_ID = "orders-email-reply-modal";

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

function ThreadMessage({ message, timezone, todayISO, onReply }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const inbound = message.direction === "inbound";
  return (
    <s-box padding="base" border="base" borderRadius="base" background={inbound ? "base" : "subdued"}>
      <s-stack gap="small">
        <s-stack direction="inline" alignItems="center" gap="small">
          <s-badge tone={inbound ? "info" : "neutral"}>{inbound ? "Customer" : "You"}</s-badge>
          <s-text type="strong">{message.fromName}</s-text>
          {message.verdict === "fail" && <s-badge tone="warning">Unverified sender</s-badge>}
        </s-stack>
        <s-text color="subdued">{`${whenLabel(message.date, timezone, todayISO)} · ${message.subject}`}</s-text>
        <EmailText text={showQuoted && message.fullText ? message.fullText : message.text} />
        <s-stack direction="inline" gap="small">
          {inbound && (
            <s-button variant="primary" onClick={() => onReply(message)}>
              Reply
            </s-button>
          )}
          {message.fullText && (
            <s-button variant="tertiary" onClick={() => setShowQuoted((v) => !v)}>
              {showQuoted ? "Hide quoted text" : "Show quoted text"}
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

/** Every email for one order (inbox and sent, 90 days), newest first. */
export function ThreadModal({ modalRef, target, openCount, timezone, todayISO, onReply }) {
  const [state, setState] = useState({ loading: false, error: null, messages: [] });

  useEffect(() => {
    if (openCount === 0 || !target) return;
    let cancelled = false;
    setState({ loading: true, error: null, messages: [] });
    loadOrderThread(target.orderId).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { loading: false, error: null, messages: result.data ?? [] }
          : { loading: false, error: result.error, messages: [] },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [openCount]);

  return (
    <s-modal id={THREAD_MODAL_ID} ref={modalRef} size="large" heading={target ? `Emails · Order ${target.name}` : "Emails"}>
      <s-stack gap="base">
        {state.loading && (
          <s-stack direction="inline" alignItems="center" gap="small">
            <s-spinner accessibilityLabel="Loading emails" />
            <s-text color="subdued">Loading emails…</s-text>
          </s-stack>
        )}
        {state.error && <s-banner tone="critical">{state.error}</s-banner>}
        {!state.loading && !state.error && state.messages.length === 0 && (
          <s-text color="subdued">No emails for this order in the last 90 days.</s-text>
        )}
        {state.messages.map((message) => (
          <ThreadMessage
            key={message.key}
            message={message}
            timezone={timezone}
            todayISO={todayISO}
            onReply={onReply}
          />
        ))}
      </s-stack>
      <s-button slot="primary-action" variant="primary" onClick={() => onReply(null)}>
        New email
      </s-button>
      <s-button slot="secondary-actions" commandFor={THREAD_MODAL_ID} command="--hide">
        Close
      </s-button>
    </s-modal>
  );
}

/** Plain-text email to the order's customer; a reply keeps the thread. */
export function ReplyModal({ modalRef, target, replyTo, openCount, onSent }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [quickReplies, setQuickReplies] = useState({ loading: false, error: null, replies: [] });

  useEffect(() => {
    if (openCount === 0 || !target) return;
    setSubject(
      replyTo ? replySubject(replyTo.subject).slice(0, MAX_SUBJECT) : `Order ${target.name}`,
    );
    setBody("");
    setError(null);
    setSending(false);
    let cancelled = false;
    setQuickReplies((current) => ({ ...current, loading: true, error: null }));
    readQuickReplies(adminClient).then((result) => {
      if (cancelled) return;
      setQuickReplies(
        result.ok
          ? { loading: false, error: null, replies: result.replies }
          : { loading: false, error: result.message, replies: [] },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [openCount]);

  const insertQuickReply = (message) =>
    setBody((current) =>
      (current.trim() ? `${current.trimEnd()}\n\n${message}` : message).slice(0, MAX_BODY),
    );

  const canSend = Boolean(target && subject.trim() && body.trim() && !sending);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const result = await sendOrderEmail({
      orderId: target.orderId,
      subject: subject.trim(),
      body: body.trim(),
      inReplyTo: replyTo?.messageId ?? undefined,
    });
    setSending(false);
    if (result.ok) {
      shopify.toast.show(result.message);
      modalRef.current?.hideOverlay?.();
      onSent?.();
    } else {
      setError(result.message);
    }
  };

  return (
    <s-modal
      id={REPLY_MODAL_ID}
      ref={modalRef}
      size="large"
      heading={target ? `${replyTo ? "Reply" : "Email"} · Order ${target.name}` : "Email"}
    >
      <s-stack gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}
        {replyTo && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="small-200">
              <s-text color="subdued">{`${replyTo.fromName} wrote:`}</s-text>
              <EmailText text={replyTo.text} />
            </s-stack>
          </s-box>
        )}
        <s-text-field
          label="Subject"
          value={subject}
          maxLength={MAX_SUBJECT}
          disabled={sending}
          onInput={(e) => setSubject(e.currentTarget.value)}
        />
        <s-stack gap="small-200">
          <s-text color="subdued">Quick replies</s-text>
          {quickReplies.loading && <s-spinner accessibilityLabel="Loading quick replies" />}
          {quickReplies.error && <s-text tone="critical">{quickReplies.error}</s-text>}
          {!quickReplies.loading && !quickReplies.error && quickReplies.replies.length === 0 && (
            <s-text color="subdued">
              No quick replies yet. Add them on the <s-link href="/settings">Delivery Scheduler</s-link> page.
            </s-text>
          )}
          {quickReplies.replies.length > 0 && (
            <s-stack direction="inline" gap="small-300">
              {quickReplies.replies.map((reply, index) => (
                <s-clickable-chip
                  key={`${index}-${reply.label}`}
                  disabled={sending}
                  accessibilityLabel={`Add quick reply: ${reply.label}`}
                  onClick={() => insertQuickReply(reply.message)}
                >
                  {reply.label}
                </s-clickable-chip>
              ))}
            </s-stack>
          )}
        </s-stack>
        <s-text-area
          label="Message"
          value={body}
          rows={8}
          maxLength={MAX_BODY}
          disabled={sending}
          onInput={(e) => setBody(e.currentTarget.value)}
          details="Plain text, sent to the customer email on the order from your business mailbox."
        />
      </s-stack>
      <s-button slot="primary-action" variant="primary" loading={sending} disabled={!canSend} onClick={send}>
        {sending ? "Sending…" : "Send email"}
      </s-button>
      <s-button slot="secondary-actions" commandFor={REPLY_MODAL_ID} command="--hide" disabled={sending}>
        Cancel
      </s-button>
    </s-modal>
  );
}

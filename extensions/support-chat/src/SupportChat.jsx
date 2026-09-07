// FlowerCart support chat — customer-account full-page extension
// (agent-core phase 2, web surface). Talks to the SAME agent brain the
// Messenger bot runs, through the enqueue-then-poll backend at
// app/routes/api.support-chat.tsx + api.support-chat_.$jobId.tsx. The brain
// speaks in neutral AgentBlock[] (see app/services/agent-channel.ts); this
// file is the ONLY place that turns those blocks into customer-account s-*
// components.
//
// This is a full-page target (customer-account.page.render), so per Shopify's
// rule it CANNOT share this extension directory with any other target —
// that's why this lives in its own extensions/support-chat/ folder instead of
// next to delivery-date-editor or delivery-reschedule-customer.
//
// Sandboxed Web Worker runtime: no DOM, no window, no localStorage — only the
// `shopify` global and Shopify's own `s-*` web components. Preact + hooks
// only, no other deps, and the compiled bundle must stay under 64 KB.

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// ---------------------------------------------------------------------------
// Backend base URL — ONE constant, change here only. Must match APP_BASE_URL
// used by the other customer-account extensions (delivery-date-editor).
// ---------------------------------------------------------------------------
const APP_BASE_URL = 'https://delivery-scheduler-299861709433.us-central1.run.app';
const SUPPORT_CHAT_START_URL = `${APP_BASE_URL}/api/support-chat`;
const SUPPORT_CHAT_POLL_URL_PREFIX = `${APP_BASE_URL}/api/support-chat/`;

// Poll backoff (2026-08-24): a typical turn answers in 3-10s, so poll fast
// only while a fast answer is still plausible, then back off — every poll is
// a signature-checked request + a Prisma read on the backend, and with the
// widget open on many storefront tabs at once the fixed 1.5s cadence was the
// dominant per-conversation query load.
const POLL_INTERVAL_FAST_MS = 1500;
const POLL_INTERVAL_SLOW_MS = 4500;
const POLL_FAST_WINDOW_MS = 10000;
// 60s, not 30s: a worst-case agent turn (multiple tool calls) can run longer
// than 30s, and the turn is written into server-side history regardless of
// whether the client is still listening — a client that gives up too early
// desyncs from what the customer actually saw. See pollForBlocks() for what
// happens if even 60s isn't enough.
const POLL_TIMEOUT_MS = 60000;
const SUPPORT_PHONE = '0962 422 4085';

export default async () => {
  render(<SupportChat />, document.body);
};

function SupportChat() {
  // Local turn history for THIS activation only — the backend is the source
  // of truth for the real conversation (loadSupportChatHistory reloads it
  // server-side on every turn), this is just what we render while the page
  // is open.
  const [turns, setTurns] = useState(
    /** @type {Array<{ role: 'customer' | 'bot', blocks?: any[], text?: string }>} */ ([]),
  );
  const [isSending, setIsSending] = useState(false);
  const [errorText, setErrorText] = useState(/** @type {string | null} */ (null));

  // GOTCHA (a): a plain onChange={(e) => e.currentTarget.value} arrow prop on
  // <s-text-field> fails Shopify's extension validator even though it shows
  // up in some migration docs. Read the live value from a ref instead.
  const inputRef = useRef(/** @type {any} */ (null));

  // Tracks whether this activation is still mounted, so a background poll
  // that resolves after the page has gone away doesn't call setState on a
  // dead component (see pollForBlocks' background continuation below).
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const sendMessage = useCallback(async (rawMessage) => {
    const message = (rawMessage ?? '').trim();
    if (!message || isSending) {
      return;
    }

    setErrorText(null);
    setTurns((prev) => [...prev, { role: 'customer', text: message }]);
    setIsSending(true);

    try {
      // Fresh session token immediately before EVERY fetch — tokens live 5
      // minutes, never cache one across calls.
      const startToken = await shopify.sessionToken.get();
      const startResponse = await fetch(SUPPORT_CHAT_START_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${startToken}`,
        },
        body: JSON.stringify({ message }),
      });

      const startBody = await startResponse.json().catch(() => ({}));
      if (!startBody?.ok || !startBody.jobId) {
        setErrorText(friendlyStartError(startBody?.reason));
        setIsSending(false);
        return;
      }

      const blocks = await pollForBlocks(startBody.jobId, {
        // If the turn finishes AFTER our 60s deadline, the server already
        // wrote it into thread history regardless — walking away here would
        // desync the next turn from what the customer actually saw. Keep
        // polling in the background and, if this activation is still open,
        // append the late reply instead of dropping it.
        onLateResult: (lateBlocks) => {
          if (!isMountedRef.current) return;
          setTurns((prev) => [...prev, { role: 'bot', blocks: lateBlocks }]);
        },
      });
      if (blocks === 'timeout') {
        setErrorText(
          "Medyo natagalan ang sagot namin, sorry po dyan. Pwede mo subukan ulit, o tumawag sa " +
            SUPPORT_PHONE +
            ' kung urgent.',
        );
        setIsSending(false);
        return;
      }

      if (blocks === null) {
        setErrorText(
          'May problema sa pag-sagot ng chat assistant. Subukan ulit, o tumawag sa ' + SUPPORT_PHONE + '.',
        );
        setIsSending(false);
        return;
      }

      setTurns((prev) => [...prev, { role: 'bot', blocks }]);
    } catch (error) {
      console.warn('[support-chat] send failed:', error instanceof Error ? error.message : 'unknown');
      setErrorText('Nawalan ng connection. Subukan ulit in a bit.');
    } finally {
      setIsSending(false);
    }
  }, [isSending]);

  const handleSendClick = useCallback(() => {
    const value = inputRef.current?.value ?? '';
    if (inputRef.current) {
      inputRef.current.value = '';
    }
    void sendMessage(value);
  }, [sendMessage]);

  // A block-derived quick action (slot or add-on choice tap) sends its payload
  // as the next customer message, same contract the Messenger [TAP] payloads
  // use. NOTHING here may send an order-commitment payload: this surface is
  // read-only support in v1, so there is no Confirm affordance to tap.
  const handlePayloadTap = useCallback(
    (payload) => {
      void sendMessage(payload);
    },
    [sendMessage],
  );

  return (
    <s-page heading="FlowerCart Support Chat">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-banner tone="info">
            <s-text>
              Kausap mo ang FlowerBot, ang AI assistant namin — hindi ito totoong tao. Kung gusto mo makausap ang
              team namin, tumawag sa {SUPPORT_PHONE} o mag-email sa hello@flowercart.store.
            </s-text>
          </s-banner>

          {errorText ? <s-banner tone="critical">{errorText}</s-banner> : null}

          {/*
            Composer stays ABOVE the thread on purpose: s-scroll-box emits no
            scroll events and this sandbox has no DOM access, so we cannot
            auto-scroll to the newest message when a reply arrives lower down.
            Keeping the input+button fixed above the scroll box means the
            customer never loses the composer even if the thread grows long —
            they just glance down to read the newest reply.
          */}
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-text-field
              ref={inputRef}
              label="Mensahe"
              placeholder="Itanong mo kung ano ang gusto mo malaman..."
              disabled={isSending}
            />
            <s-button variant="primary" disabled={isSending} onClick={handleSendClick}>
              Send
            </s-button>
          </s-stack>

          {isSending ? (
            <s-stack direction="inline" gap="small-200" justifyContent="center">
              <s-spinner accessibilityLabel="Sinasagot ka namin..." size="small" />
              <s-text color="subdued">Sinasagot ka namin...</s-text>
            </s-stack>
          ) : null}

          <s-scroll-box blockSize="420px" padding="base" accessibilityLabel="Chat history">
            <s-stack direction="block" gap="base">
              {turns.length === 0 ? (
                <s-text color="subdued">
                  Hi! Ako si FlowerBot. Pwede mo akong tanungin tungkol sa mga bouquet, delivery dates, delivery
                  fees, o status ng order mo.
                </s-text>
              ) : null}
              {turns.map((turn, index) => (
                <TurnView key={index} turn={turn} onPayloadTap={handlePayloadTap} />
              ))}
            </s-stack>
          </s-scroll-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function TurnView({ turn, onPayloadTap }) {
  if (turn.role === 'customer') {
    return (
      <s-box padding="small-200" borderRadius="base" background="subdued">
        <s-text>{turn.text}</s-text>
      </s-box>
    );
  }

  const blocks = turn.blocks ?? [];
  return (
    <s-stack direction="block" gap="small-300">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} onPayloadTap={onPayloadTap} />
      ))}
    </s-stack>
  );
}

function BlockView({ block, onPayloadTap }) {
  switch (block.type) {
    case 'text':
      return <s-text>{block.text}</s-text>;

    case 'products':
      // Block items are MessengerProduct objects — NOT { image, title, price }.
      // Real shape: { productTitle, variantId, variantTitle?, pricePhp, imageUrl?,
      // url?, available, description? }. The system prompt tells the model to
      // keep its own text to one short intro and never list names/prices itself,
      // trusting these cards to carry that info — so every field here must be
      // read correctly or the model's silence becomes a truly empty reply.
      return (
        <s-stack direction="block" gap="small-200">
          {(block.items ?? []).map((item, index) => {
            const title = item?.productTitle ?? '';
            const priceText =
              typeof item?.pricePhp === 'number'
                ? `₱${item.pricePhp.toLocaleString('en-PH')}`
                : null;
            const card = (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-product-thumbnail src={item?.imageUrl ?? undefined} alt={title} />
                <s-stack direction="block" gap="small-100">
                  <s-text>{title}</s-text>
                  {item?.available === false ? (
                    <s-badge tone="warning">Out of stock</s-badge>
                  ) : priceText ? (
                    <s-text color="subdued">{priceText}</s-text>
                  ) : null}
                </s-stack>
              </s-stack>
            );
            return item?.url ? (
              <s-link key={index} href={item.url}>
                {card}
              </s-link>
            ) : (
              <s-box key={index}>{card}</s-box>
            );
          })}
        </s-stack>
      );

    case 'slots':
      return (
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">{block.date}</s-text>
          <s-stack direction="inline" gap="small-200">
            {(block.slots ?? []).map((slot, index) => (
              <s-clickable-chip key={index} onClick={() => onPayloadTap(`[TAP] ${slot.value}`)}>
                {slot.label}
              </s-clickable-chip>
            ))}
          </s-stack>
        </s-stack>
      );

    case 'choices':
      return (
        <s-stack direction="inline" gap="small-200">
          {(block.options ?? []).map((option, index) => (
            <s-clickable-chip key={index} onClick={() => onPayloadTap(`[TAP] ${option.payload}`)}>
              {option.label}
            </s-clickable-chip>
          ))}
        </s-stack>
      );

    case 'order':
      return (
        <s-box border="base" borderRadius="base" padding="small-300">
          <s-stack direction="block" gap="small-100">
            <s-text>{block.name}</s-text>
            <s-badge tone="neutral">{block.financialStatus}</s-badge>
            <s-badge tone="neutral">{block.fulfillmentStatus}</s-badge>
            {block.deliveryDate ? <s-text color="subdued">Delivery date: {block.deliveryDate}</s-text> : null}
            {block.deliveryTime ? <s-text color="subdued">Delivery time: {block.deliveryTime}</s-text> : null}
            {block.trackingUrl ? <s-link href={block.trackingUrl}>Track your order</s-link> : null}
          </s-stack>
        </s-box>
      );

    case 'summary':
      // NO Confirm button here, on purpose. Ordering is Messenger-only in v1
      // (CUSTOMER_ACCOUNT_CAPABILITIES.ordering === false), and the
      // deterministic CONFIRM_ORDER_<key> interception lives only in the
      // Messenger adapter — a Confirm button on this surface would send its
      // payload to the LLM as ordinary text and commit nothing. agent-core
      // already drops summary blocks for this channel; if one ever slips
      // through we render its text and nothing else.
      return <s-text>{block.text}</s-text>;

    default:
      return null;
  }
}

// A turn that's still running past POLL_TIMEOUT_MS keeps running server-side
// (and gets written into thread history) whether or not the client is still
// watching. So instead of abandoning it, we keep polling in the background
// for a while longer and hand the late result to onLateResult if it shows up.
// Bounded, not unbounded — a customer who closed the page shouldn't leave a
// forever-running poll loop in whatever's left of the worker.
const BACKGROUND_POLL_TIMEOUT_MS = 4 * 60 * 1000;

// ---------------------------------------------------------------------------
// Poll the jobId endpoint (fast, then backed-off) until status is "done" or
// "failed", or POLL_TIMEOUT_MS elapses. Returns the block array on success,
// null on a backend-reported failure, or the string 'timeout' on timeout —
// in the timeout case, polling continues in the background (see above) and
// onLateResult is called if/when the turn eventually resolves.
// ---------------------------------------------------------------------------
async function pollForBlocks(jobId, { onLateResult } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(
      Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_SLOW_MS,
    );

    const result = await pollOnce(jobId);
    if (result.state === 'pending') {
      continue;
    }
    if (result.state === 'done') {
      return result.blocks;
    }
    // 'failed'
    return null;
  }

  void continuePollingInBackground(jobId, onLateResult);
  return 'timeout';
}

async function continuePollingInBackground(jobId, onLateResult) {
  const backgroundDeadline = Date.now() + BACKGROUND_POLL_TIMEOUT_MS;

  while (Date.now() < backgroundDeadline) {
    // A turn already past the 60s foreground window is slow by definition —
    // the fast cadence buys nothing here.
    await sleep(POLL_INTERVAL_SLOW_MS);

    const result = await pollOnce(jobId);
    if (result.state === 'pending') {
      continue;
    }
    if (result.state === 'done') {
      onLateResult?.(result.blocks);
    }
    // 'done' (delivered above) or 'failed': either way, nothing left to poll.
    return;
  }
}

// Single poll attempt, normalized to one of: pending / done (with blocks) /
// failed. A network error is treated as "pending" (try again next tick)
// rather than "failed" — a dropped fetch isn't a backend-reported failure.
async function pollOnce(jobId) {
  // Fresh session token before EVERY poll fetch — never reuse the token from
  // the initial POST or a prior poll.
  const token = await shopify.sessionToken.get();
  let body;
  try {
    const response = await fetch(`${SUPPORT_CHAT_POLL_URL_PREFIX}${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    console.warn('[support-chat] poll failed:', error instanceof Error ? error.message : 'unknown');
    return { state: 'pending' };
  }

  if (!body?.ok) {
    return { state: 'failed' };
  }
  if (body.status === 'pending') {
    return { state: 'pending' };
  }
  if (body.status === 'done') {
    return { state: 'done', blocks: Array.isArray(body.blocks) ? body.blocks : [] };
  }
  // status === "failed"
  return { state: 'failed' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function friendlyStartError(reason) {
  if (reason === 'not_signed_in') {
    return 'Kailangan mo mag-log in muna para makausap ang chat assistant namin.';
  }
  if (reason === 'message_too_long') {
    return 'Masyadong mahaba ang mensahe mo — paikliin mo pa konti.';
  }
  return 'Hindi namin na-send ang mensahe mo. Subukan ulit, o tumawag sa ' + SUPPORT_PHONE + '.';
}

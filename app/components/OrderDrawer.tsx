import { Fragment, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  type Order,
  type CustomAttribute,
  type BadgeTone,
  toLocalISODate,
  formatDeliveryDate,
  formatMoney,
  financialStatusTone,
  fulfillmentStatusTone,
  isOpenFulfillmentStatus,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getCity,
  getInstructionValue,
  getAttr,
  getFullShippingAddress,
  buildDeliveryInfoText,
  getRescheduleTimelineEvents,
  hasRescheduleTag,
  formatTimelineDelivery,
  formatTimelineTimestamp,
  formatTimelineStatus,
} from "../lib/order-utils";

export type { Order, CustomAttribute };

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const polarisTone =
    tone === "neutral" ? undefined :
    tone === "caution" ? "warning" :
    tone;
  if (polarisTone) {
    return <s-badge tone={polarisTone}>{label}</s-badge>;
  }
  return <s-badge>{label}</s-badge>;
}

// ─── OrderDrawer ──────────────────────────────────────────────────────────────

export interface OrderDrawerProps {
  order: Order;
  onClose: () => void;
}

export function OrderDrawer({ order, onClose }: OrderDrawerProps) {
  const { copied, fieldCopied, copyText, copyField } = useCopyToClipboard();
  const tagFetcher = useFetcher<{ ok: boolean; message?: string; summary?: { ok: number; failed: number } }>();
  const [tagInput, setTagInput] = useState("");

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const todayISO = toLocalISODate(new Date());
  const isOpenOrder = isOpenFulfillmentStatus(order.displayFulfillmentStatus);
  const deliveryRelative =
    rawDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDate, todayISO);
  const timeWindow = getDeliveryTimeValue(order);
  const addr = order.shippingAddress;
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const attrs = order.customAttributes || [];
  const originalDeliveryDate = getAttr(attrs, "Delivery Date");
  const originalDeliveryTime = getAttr(attrs, "Delivery Time");
  const rescheduleEvents = getRescheduleTimelineEvents(order);
  const showDeliveryTimeline =
    rescheduleEvents.length > 0 || hasRescheduleTag(order);
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  const instruction = getInstructionValue(order);
  const items = order.lineItems?.edges || [];
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const shippingAmount = order.totalShippingPriceSet
    ? parseFloat(order.totalShippingPriceSet.shopMoney.amount)
    : 0;
  const totalAmount = order.currentTotalPriceSet
    ? parseFloat(order.currentTotalPriceSet.shopMoney.amount)
    : 0;
  const currencyCode =
    order.currentTotalPriceSet?.shopMoney.currencyCode ||
    order.totalShippingPriceSet?.shopMoney.currencyCode ||
    "USD";
  const subtotalFormatted =
    order.currentTotalPriceSet
      ? formatMoney((totalAmount - shippingAmount).toFixed(2), currencyCode)
      : "—";
  const shippingFormatted =
    order.totalShippingPriceSet
      ? formatMoney(order.totalShippingPriceSet.shopMoney.amount, currencyCode)
      : "—";
  const meaningfulTags = getMeaningfulTags(order.tags || []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    // Lock body scroll while drawer is open
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    if (tagFetcher.state === "idle" && tagFetcher.data?.ok) {
      setTagInput("");
    }
  }, [tagFetcher.state, tagFetcher.data]);

  return (
    <>
      {/* Backdrop */}
      <div className="ods-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        className="ods-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${order.name} details`}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="ods-drawer-head">
          <div className="ods-drawer-head-row">
            <div>
              <p className="ods-drawer-order-num">{order.name}</p>
              <div className="ods-drawer-badges">
                <StatusBadge
                  tone={financialStatusTone(order.displayFinancialStatus)}
                  label={formatStatusLabel(order.displayFinancialStatus)}
                />
                <StatusBadge
                  tone={fulfillmentStatusTone(order.displayFulfillmentStatus)}
                  label={formatStatusLabel(order.displayFulfillmentStatus)}
                />
              </div>
            </div>
            <button
              className="ods-drawer-close"
              onClick={onClose}
              aria-label="Close order details"
            >
              ×
            </button>
          </div>
          <p className="ods-drawer-customer">
            <span>{customerName}</span>
            {order.customer?.numberOfOrders != null && order.customer.numberOfOrders > 0 && (
              <span className="ods-loyalty-count">{order.customer.numberOfOrders} orders</span>
            )}
          </p>
          <p className="ods-drawer-total">{total}</p>
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <div className="ods-drawer-body">
          {/* Delivery section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Delivery</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Date</dt>
              <dd className="ods-dd">
                <span className="ods-drawer-delivery-date">
                  <span>{deliveryDate}</span>
                  {deliveryRelative && (
                    <span
                      className={`ods-delivery-relative${deliveryOverdue ? " ods-delivery-relative--overdue" : ""}`}
                    >
                      {deliveryRelative}
                    </span>
                  )}
                </span>
              </dd>
              <dt className="ods-dt">Time window</dt>
              <dd className="ods-dd">{timeWindow}</dd>
              <dt className="ods-dt">Address</dt>
              <dd className="ods-dd ods-dd--long">{fullAddress || "—"}</dd>
              <dt className="ods-dt">City</dt>
              <dd className="ods-dd">{city || "—"}</dd>
              {addr?.province && (
                <>
                  <dt className="ods-dt">Province</dt>
                  <dd className="ods-dd">
                    <span
                      className={`ods-copyable${fieldCopied === "province" ? " ods-copyable--copied" : ""}`}
                      onClick={() => copyField("province", addr.province!)}
                      title="Click to copy"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && copyField("province", addr.province!)}
                    >
                      {addr.province}
                      <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                    </span>
                  </dd>
                </>
              )}
              <dt className="ods-dt">Card message</dt>
              <dd className={`ods-dd${cardMessage === "—" ? " ods-dd--muted" : " ods-dd--scrollable"}`}>
                {cardMessage !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "cardMessage" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("cardMessage", cardMessage)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("cardMessage", cardMessage)}
                  >
                    {cardMessage}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : cardMessage}
              </dd>
              <dt className="ods-dt">Instructions</dt>
              <dd className={`ods-dd${instruction === "—" ? " ods-dd--muted" : " ods-dd--scrollable"}`}>
                {instruction !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "instruction" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("instruction", instruction)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("instruction", instruction)}
                  >
                    {instruction}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : instruction}
              </dd>
            </dl>
            <div className="ods-drawer-actions">
              <button
                className="ods-action-icon"
                onClick={() => copyText(buildDeliveryInfoText(order))}
                data-tooltip={copied ? "Copied!" : "Copy delivery info"}
                aria-label="Copy all delivery info"
              >
                {copied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <path d="M4 10l5 5 7-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <rect x="7" y="2" width="6" height="3" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M6 3H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 10h4M8 13h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {showDeliveryTimeline && (
            <div className="ods-drawer-section">
              <p className="ods-section-title">DELIVERY TIMELINE</p>
              <dl className="ods-dl">
                <dt className="ods-dt">Original delivery</dt>
                <dd className="ods-dd">
                  {formatTimelineDelivery(
                    originalDeliveryDate,
                    originalDeliveryTime,
                  )}
                </dd>
                {rescheduleEvents.length > 0 ? (
                  <>
                    <dt className="ods-dt">Count</dt>
                    <dd className="ods-dd">
                      Rescheduled {rescheduleEvents.length}x
                    </dd>
                    {rescheduleEvents.map((event, index) => (
                      <Fragment
                        key={`${event.requestedAt}-${event.date}-${event.timeSlot}-${index}`}
                      >
                        <dt className="ods-dt">
                          {index === 0 ? "Latest" : `Change ${index + 1}`}
                        </dt>
                        <dd className="ods-dd">
                          <span className="ods-drawer-delivery-date">
                            <span>
                              {formatTimelineDelivery(
                                event.date,
                                event.timeSlot,
                              )}
                            </span>
                            <span className="ods-delivery-relative">
                              {formatTimelineTimestamp(event.requestedAt)} •{" "}
                              {formatTimelineStatus(event.status)}
                            </span>
                          </span>
                        </dd>
                      </Fragment>
                    ))}
                  </>
                ) : (
                  <>
                    <dt className="ods-dt">Status</dt>
                    <dd className="ods-dd">
                      Rescheduled — history not yet recorded
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {/* Items section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Items ({items.length})</p>
            {items.length === 0 ? (
              <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
                No items.
              </p>
            ) : (
              <div>
                {items.map((edge, idx) => {
                  const item = edge.node;
                  const imgUrl =
                    item.image?.url || item.product?.featuredImage?.url;
                  const imgAlt =
                    item.image?.altText ||
                    item.product?.featuredImage?.altText ||
                    item.name;
                  return (
                    <div key={idx} className="ods-item-row">
                      {imgUrl ? (
                        <img
                          className="ods-item-thumb"
                          src={imgUrl}
                          alt={imgAlt}
                        />
                      ) : (
                        <div className="ods-item-thumb-placeholder" />
                      )}
                      <div className="ods-item-info">
                        <div className="ods-item-name">{item.name}</div>
                        {item.sku && (
                          <div className="ods-item-sku">SKU: {item.sku}</div>
                        )}
                      </div>
                      <div className="ods-item-qty">× {item.quantity}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Totals */}
            <div className="ods-totals">
              <div className="ods-totals-row">
                <span className="ods-totals-label">Subtotal</span>
                <span className="ods-totals-value">{subtotalFormatted}</span>
              </div>
              <div className="ods-totals-row">
                <span className="ods-totals-label">Shipping</span>
                <span className="ods-totals-value">{shippingFormatted}</span>
              </div>
              <div className="ods-totals-row ods-totals-row--total">
                <span className="ods-totals-label">Total</span>
                <span className="ods-totals-value">{total}</span>
              </div>
            </div>
          </div>

          {/* Admin link */}
          <div className="ods-drawer-section">
            <div className="ods-drawer-actions">
              <a
                href={`shopify://admin/orders/${orderId}`}
                className="ods-action-link"
              >
                Open in Shopify Admin
              </a>
            </div>
          </div>

          {/* Tags section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Tags</p>
            {meaningfulTags.length === 0 ? (
              <p className="ods-tag-empty">No tags</p>
            ) : (
              <ul className="ods-tag-list">
                {meaningfulTags.map((tag) => (
                  <li key={tag} className="ods-tag-pill">
                    {tagDisplayLabel(tag)}
                  </li>
                ))}
              </ul>
            )}
            <tagFetcher.Form
              method="post"
              className="ods-tag-input-row"
              onSubmit={(e) => {
                if (!tagInput.trim()) { e.preventDefault(); return; }
              }}
            >
              <input type="hidden" name="_action" value="tagsAdd" />
              <input type="hidden" name="orderId" value={order.id} />
              <input
                className="ods-tag-input"
                type="text"
                name="tags"
                placeholder="Add a tag…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                disabled={tagFetcher.state !== "idle"}
                maxLength={255}
                autoComplete="off"
              />
              <button
                type="submit"
                className="ods-tag-add-btn"
                disabled={!tagInput.trim() || tagFetcher.state !== "idle"}
              >
                {tagFetcher.state !== "idle" ? "Adding…" : "Add"}
              </button>
            </tagFetcher.Form>
            {tagFetcher.state === "idle" && tagFetcher.data && !tagFetcher.data.ok && (
              <p className="ods-tag-error">{tagFetcher.data.message ?? "Failed to add tag."}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

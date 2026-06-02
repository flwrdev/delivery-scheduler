import { Fragment, useEffect } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  type Order,
  type CustomAttribute,
  type BadgeTone,
  type RescheduleTimelineEvent,
  toLocalISODate,
  normalizeDateToISO,
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
  getOrderPhone,
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
  return (
    <span className={`ods-badge ods-badge--${tone}`}>
      {label}
    </span>
  );
}

// ─── OrderDrawer ──────────────────────────────────────────────────────────────

export interface OrderDrawerProps {
  order: Order;
  onClose: () => void;
}

export function OrderDrawer({ order, onClose }: OrderDrawerProps) {
  const { copied, fieldCopied, copyText, copyField } = useCopyToClipboard();

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const phone = getOrderPhone(order);
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
  const email = order.customer?.defaultEmailAddress?.emailAddress || "—";
  const customerId = order.customer?.id?.split("/").pop();
  const billingAddress = order.billingAddress ?? null;
  const showSenderInfo =
    billingAddress != null &&
    billingAddress.address1 != null &&
    billingAddress.address1 !== (order.shippingAddress?.address1 ?? "");
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
          <p className="ods-drawer-customer">{customerName}</p>
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
              <button className="ods-action-link ods-action-link--with-icon" onClick={() => copyText(buildDeliveryInfoText(order))}>
                {copied ? (
                  "✓ Copied!"
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                      <rect x="7" y="2" width="6" height="3" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M6 3H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      <path d="M8 10h4M8 13h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    Copy all delivery info
                  </>
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

          {/* Customer section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Customer</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Name</dt>
              <dd className="ods-dd">
                <span
                  className={`ods-copyable${fieldCopied === "customerName" ? " ods-copyable--copied" : ""}`}
                  onClick={() => copyField("customerName", customerName)}
                  title="Click to copy"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && copyField("customerName", customerName)}
                >
                  {customerName || "—"}
                  <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </span>
              </dd>
              <dt className="ods-dt">Email</dt>
              <dd className="ods-dd ods-dd--long">{email}</dd>
              <dt className="ods-dt">Phone</dt>
              <dd className="ods-dd">
                {phone !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "phone" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("phone", phone)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("phone", phone)}
                  >
                    {phone}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : "—"}
              </dd>
            </dl>
            <div className="ods-drawer-actions">
              {phone !== "—" && (
                <a
                  href={`tel:${phone}`}
                  className="ods-action-icon"
                  data-tooltip="Call customer"
                  aria-label="Call customer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <path d="M3 5a2 2 0 0 1 2-2h.5a1 1 0 0 1 .95.68l.8 2.4a1 1 0 0 1-.23 1.02L6 8.12A11.05 11.05 0 0 0 11.88 14l1.02-1.02a1 1 0 0 1 1.02-.23l2.4.8A1 1 0 0 1 17 14.5V15a2 2 0 0 1-2 2h-.5C8.6 17 3 11.4 3 5.5V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                  </svg>
                </a>
              )}
              {phone !== "—" && (
                <a
                  href={`sms:${phone}`}
                  className="ods-action-icon"
                  data-tooltip="Text customer"
                  aria-label="Text customer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <path d="M4 4h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                    <path d="M7 8.5h6M7 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </a>
              )}
              {customerId && (
                <a
                  href={`shopify://admin/customers/${customerId}`}
                  className="ods-action-icon"
                  data-tooltip="View customer"
                  aria-label="View customer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M4 17c0-3.31 2.69-6 6-6s6 2.69 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </a>
              )}
            </div>
          </div>

          {/* Sender Info section — only when billing ≠ shipping (gift orders) */}
          {showSenderInfo && (
            <div className="ods-drawer-section">
              <p className="ods-section-title">Sender Info</p>
              <dl className="ods-dl">
                {billingAddress!.name && (
                  <>
                    <dt className="ods-dt">Sender Name</dt>
                    <dd className="ods-dd">{billingAddress!.name}</dd>
                  </>
                )}
                {billingAddress!.address1 && (
                  <>
                    <dt className="ods-dt">Address</dt>
                    <dd className="ods-dd ods-dd--long">{billingAddress!.address1}</dd>
                  </>
                )}
                {billingAddress!.phone && (
                  <>
                    <dt className="ods-dt">Sender Phone</dt>
                    <dd className="ods-dd">{billingAddress!.phone}</dd>
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
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  FormLayout,
  InlineStack,
  Modal,
  Text,
  TextField,
} from "@shopify/polaris";
import { type Order, isCancelled } from "../../lib/order-utils";
import type { EditDetailsResponse } from "../../services/update-order-contact.server";

// "Edit details" modal — opened from the details panel's Actions menu, single
// order only. Rewrites the shipping address: street, apartment, city, ZIP, and
// the RECEIVER's phone (the number the rider calls).
//
// Deliberately NOT editable here:
//   · Recipient name, company, province, country, ZIP — carried forward
//     untouched by the server. Shown read-only below the form so the merchant
//     can see they survive. The ZIP is in that list because Shopify rejects an
//     empty PH postal code and fails the whole save with it; it can't be
//     cleared, it's rarely the wrong field, and a form row for it only cost
//     the merchant time.
//   · Sender phone — that lives on the customer record and would need the
//     write_customers scope, which forces a merchant reinstall.
export interface EditDetailsModalProps {
  open: boolean;
  onClose: () => void;
  order: Order | null;
}

const MAX_ADDRESS_LINE = 255;
const MAX_CITY = 128;
const MAX_PHONE = 32;

const IN_TRANSIT_STATUSES = new Set([
  "FULFILLED",
  "PARTIALLY_FULFILLED",
  "IN_PROGRESS",
]);

export function EditDetailsModal({
  open,
  onClose,
  order,
}: EditDetailsModalProps) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<EditDetailsResponse>();
  const isSubmitting = fetcher.state !== "idle";

  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addr = order?.shippingAddress ?? null;

  // Prefill from the stored address each time the modal opens (same pattern as
  // RescheduleModal / SendEmailModal). Not keyed on `order` — a background
  // revalidation must never rewrite what the merchant is halfway through typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setAddress1(addr?.address1 ?? "");
      setAddress2(addr?.address2 ?? "");
      setCity(addr?.city ?? "");
      setPhone(addr?.phone ?? "");
      setError(null);
    }
    wasOpenRef.current = open;
  }, [open, addr]);

  // Success → toast + close. Failure → banner INSIDE the modal so the typed
  // values are never lost; the fields stay editable for a retry.
  const handledDataRef = useRef<EditDetailsResponse | null>(null);
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      onClose();
    } else {
      setError(fetcher.data.message || "Failed to update the details.");
    }
  }, [fetcher.data, fetcher.state, shopify, onClose]);

  const preserved = useMemo(() => {
    const name = [addr?.firstName, addr?.lastName].filter(Boolean).join(" ");
    const region = [addr?.province, addr?.country].filter(Boolean).join(", ");
    return [
      name ? `Recipient: ${name}` : null,
      addr?.company ? `Company: ${addr.company}` : null,
      region ? `Region: ${region}` : null,
      addr?.zip ? `ZIP: ${addr.zip}` : null,
    ].filter(Boolean) as string[];
  }, [addr]);

  const inTransit = Boolean(
    order &&
      !isCancelled(order) &&
      IN_TRANSIT_STATUSES.has(order.displayFulfillmentStatus?.toUpperCase()),
  );
  const cityChanged =
    city.trim() !== (addr?.city ?? "").trim() && city.trim().length > 0;

  const dirty =
    address1.trim() !== (addr?.address1 ?? "").trim() ||
    address2.trim() !== (addr?.address2 ?? "").trim() ||
    cityChanged ||
    phone.trim() !== (addr?.phone ?? "").trim();

  const canSave =
    !isSubmitting &&
    Boolean(order) &&
    address1.trim().length > 0 &&
    city.trim().length > 0 &&
    dirty;

  const handleSave = () => {
    if (!order) return;
    setError(null);
    const fd = new FormData();
    fd.append("_action", "editDetails");
    fd.append("orderId", order.id);
    fd.append("address1", address1);
    fd.append("address2", address2);
    fd.append("city", city);
    fd.append("phone", phone);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={order ? `Edit details · ${order.name}` : "Edit details"}
      primaryAction={{
        content: isSubmitting ? "Saving…" : "Save details",
        onAction: handleSave,
        loading: isSubmitting,
        disabled: !canSave,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error && (
            <Banner tone="critical" title="The details were not saved">
              <p>{error}</p>
            </Banner>
          )}

          {inTransit && (
            <Banner tone="warning" title="This order is already on its way">
              <p>
                Changing the address here updates the order record, but it does
                not move a parcel the rider already has. Contact the courier
                directly if the delivery needs to be redirected.
              </p>
            </Banner>
          )}

          {cityChanged && (
            <Banner tone="warning" title="The delivery fee will not change">
              <p>
                Shipping on this order was priced by the courier at checkout.
                Moving the order to a different city does not re-price it — you
                will need to collect or refund any difference yourself.
              </p>
            </Banner>
          )}

          <FormLayout>
            <TextField
              label="Street address"
              value={address1}
              onChange={setAddress1}
              maxLength={MAX_ADDRESS_LINE}
              autoComplete="address-line1"
              requiredIndicator
              disabled={isSubmitting}
            />
            <TextField
              label="Apartment, suite, unit"
              value={address2}
              onChange={setAddress2}
              maxLength={MAX_ADDRESS_LINE}
              autoComplete="address-line2"
              disabled={isSubmitting}
            />
            <TextField
              label="City"
              value={city}
              onChange={setCity}
              maxLength={MAX_CITY}
              autoComplete="address-level2"
              requiredIndicator
              disabled={isSubmitting}
            />
            <TextField
              label="Receiver phone"
              type="tel"
              value={phone}
              onChange={setPhone}
              maxLength={MAX_PHONE}
              autoComplete="tel"
              helpText="The number the rider calls on arrival. The customer's own phone on file is not changed."
              disabled={isSubmitting}
            />
          </FormLayout>

          {preserved.length > 0 && (
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Kept as is
              </Text>
              <InlineStack gap="300" wrap>
                {preserved.map((line) => (
                  <Text key={line} as="span" variant="bodySm">
                    {line}
                  </Text>
                ))}
              </InlineStack>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

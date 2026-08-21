import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Autocomplete,
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
import {
  createSessionToken,
  fetchAddressSuggestions,
  loadPlacesLibrary,
  resolvePlace,
  type AddressSuggestion,
} from "../../lib/google-places.client";

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
  /** Google Maps key; empty string hides the address search entirely. */
  mapsApiKey: string;
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
  mapsApiKey,
}: EditDetailsModalProps) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<EditDetailsResponse>();
  const isSubmitting = fetcher.state !== "idle";

  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [phone, setPhone] = useState("");
  // Set only by the address search — there is no manual ZIP input. null means
  // "leave the stored ZIP alone"; a value is submitted alongside the address.
  const [zip, setZip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Address search (Google Places). placesReady stays false — and the search
  // field stays hidden — when there is no key or the SDK fails to load.
  const [placesReady, setPlacesReady] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchOptions, setSearchOptions] = useState<
    Array<{ value: string; label: string }>
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const suggestionsRef = useRef<AddressSuggestion[]>([]);
  const sessionTokenRef = useRef<object | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

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
      setZip(null);
      setError(null);
      setSearchValue("");
      setSearchOptions([]);
      setSearchError(null);
      suggestionsRef.current = [];
      sessionTokenRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open, addr]);

  // Load the Maps SDK on first open only — never on page load, and never
  // without a key. A load failure simply keeps the search field hidden.
  useEffect(() => {
    if (!open || !mapsApiKey || placesReady) return;
    let cancelled = false;
    loadPlacesLibrary(mapsApiKey)
      .then(() => {
        if (!cancelled) setPlacesReady(true);
      })
      .catch(() => {
        if (!cancelled) setPlacesReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mapsApiKey, placesReady]);

  // Clear a pending suggestion fetch on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const runSearch = async (query: string) => {
    const seq = ++searchSeqRef.current;
    setSearchLoading(true);
    try {
      if (!sessionTokenRef.current) {
        sessionTokenRef.current = await createSessionToken(mapsApiKey);
      }
      const results = await fetchAddressSuggestions(
        mapsApiKey,
        query,
        sessionTokenRef.current,
      );
      if (seq !== searchSeqRef.current) return; // a newer keystroke superseded us
      suggestionsRef.current = results;
      setSearchOptions(results.map((r) => ({ value: r.placeId, label: r.label })));
    } catch {
      if (seq === searchSeqRef.current) setSearchOptions([]);
    } finally {
      if (seq === searchSeqRef.current) setSearchLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchValue(value);
    setSearchError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = value.trim();
    if (query.length < 3) {
      setSearchOptions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(query);
    }, 300);
  };

  const handleSearchSelect = async ([selectedId]: string[]) => {
    const item = suggestionsRef.current.find((s) => s.placeId === selectedId);
    if (!item) return;
    setSearchOptions([]);
    setSearchValue(item.label);
    setSearchLoading(true);
    try {
      const mapped = await resolvePlace(item);
      setAddress1(mapped.address1);
      // A picked place without a unit number must not wipe one the merchant
      // already typed — units are exactly what Google usually doesn't know.
      if (mapped.address2) setAddress2(mapped.address2);
      if (mapped.city) setCity(mapped.city);
      setZip(mapped.zip || null);
    } catch {
      setSearchError(
        "Couldn't fetch that address — fill in the fields below manually.",
      );
    } finally {
      setSearchLoading(false);
      // fetchFields closed the billing session; the next keystroke starts a new one.
      sessionTokenRef.current = null;
    }
  };

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

  const newZip = zip?.trim() ?? "";
  const zipChanged = newZip.length > 0 && newZip !== (addr?.zip ?? "").trim();

  const preserved = useMemo(() => {
    const name = [addr?.firstName, addr?.lastName].filter(Boolean).join(" ");
    const region = [addr?.province, addr?.country].filter(Boolean).join(", ");
    const zipLine = zipChanged
      ? `ZIP: ${newZip} (updated from address search)`
      : addr?.zip
        ? `ZIP: ${addr.zip}`
        : null;
    return [
      name ? `Recipient: ${name}` : null,
      addr?.company ? `Company: ${addr.company}` : null,
      region ? `Region: ${region}` : null,
      zipLine,
    ].filter(Boolean) as string[];
  }, [addr, newZip, zipChanged]);

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
    zipChanged ||
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
    // Only ever a non-empty ZIP from the address search — a blank one would
    // fail the whole Shopify mutation (see update-order-contact.server.ts).
    if (newZip) fd.append("zip", newZip);
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

          {placesReady && (
            <Autocomplete
              options={searchOptions}
              selected={[]}
              onSelect={handleSearchSelect}
              loading={searchLoading}
              textField={
                <Autocomplete.TextField
                  label="Search address"
                  value={searchValue}
                  onChange={handleSearchChange}
                  placeholder="e.g. 11 Kalayaan Ave, Quezon City"
                  helpText="Pick a suggestion to fill in the fields below automatically. The ZIP updates with it."
                  error={searchError ?? undefined}
                  autoComplete="off"
                  disabled={isSubmitting}
                />
              }
            />
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

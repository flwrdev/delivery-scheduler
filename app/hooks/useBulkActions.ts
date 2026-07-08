import {
  useState,
  useCallback,
  useEffect,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { BulkActionName, BulkActionResponse } from "../routes/app.orders";

// Bulk-action state, submission, and toast/result handling for /app/orders.
// Moved verbatim from the route's Extension() component — same state shapes
// and same effect dependencies (behavior-preserving extraction).
export function useBulkActions(
  selectedIds: Set<string>,
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>,
) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<BulkActionResponse>();
  const isSubmitting: boolean = fetcher.state !== "idle";

  // Cancel modal form state
  const [cancelReason, setCancelReason] = useState<string>("CUSTOMER");
  const [cancelRestock, setCancelRestock] = useState<boolean>(false);
  const [cancelNotify, setCancelNotify] = useState<boolean>(false);
  const [cancelStaffNote, setCancelStaffNote] = useState<string>("");

  // Tag modal form state
  const [addTagsInput, setAddTagsInput] = useState<string>("");
  const [removeTagsInput, setRemoveTagsInput] = useState<string>("");

  // Mark as fulfilled modal form state
  const [fulfillTrackingNumber, setFulfillTrackingNumber] =
    useState<string>("");
  const [fulfillTrackingUrl, setFulfillTrackingUrl] = useState<string>("");
  const [fulfillNotify, setFulfillNotify] = useState<boolean>(false);
  const [fulfillPhotoFile, setFulfillPhotoFile] = useState<File | null>(null);
  const [fulfillPhotoPreview, setFulfillPhotoPreview] = useState<string>("");
  const [fulfillPhotoError, setFulfillPhotoError] = useState<string>("");

  const hideModal = (id: string) => {
    const el = document.getElementById(id) as
      | (HTMLElement & { hide?: () => void })
      | null;
    if (!el) return;
    if (typeof el.hide === "function") el.hide();
    else el.removeAttribute("open");
  };

  const showModal = (id: string) => {
    const el = document.getElementById(id) as
      | (HTMLElement & { show?: () => void })
      | null;
    if (!el) return;
    if (typeof el.show === "function") el.show();
    else el.setAttribute("open", "");
  };

  const submitBulk = useCallback(
    (op: BulkActionName, extras?: Record<string, string>) => {
      if (selectedIds.size === 0) return;
      const fd = new FormData();
      fd.append("_action", op);
      selectedIds.forEach((id) => fd.append("orderId", id));
      if (extras) {
        for (const [k, v] of Object.entries(extras)) fd.append(k, v);
      }
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher, selectedIds],
  );

  const handleArchive = () => showModal("modal-archive-orders");
  const handleUnarchive = () => showModal("modal-unarchive-orders");
  const handleArchiveConfirm = () => submitBulk("archive");
  const handleUnarchiveConfirm = () => submitBulk("unarchive");

  const handleCancelConfirm = () => {
    submitBulk("cancel", {
      reason: cancelReason,
      restock: cancelRestock ? "1" : "0",
      notifyCustomer: cancelNotify ? "1" : "0",
      staffNote: cancelStaffNote,
    });
  };

  const handleAddTags = () => {
    if (!addTagsInput.trim()) return;
    submitBulk("tagsAdd", { tags: addTagsInput });
  };

  const handleRemoveTags = () => {
    if (!removeTagsInput.trim()) return;
    submitBulk("tagsRemove", { tags: removeTagsInput });
  };

  const handleMarkFulfilled = useCallback(() => {
    if (selectedIds.size === 0) return;
    const fd = new FormData();
    fd.append("_action", "markFulfilled");
    selectedIds.forEach((id) => fd.append("orderId", id));
    fd.append("trackingNumber", fulfillTrackingNumber);
    fd.append("trackingUrl", fulfillTrackingUrl);
    fd.append("notifyCustomer", fulfillNotify ? "1" : "0");
    if (fulfillPhotoFile) fd.append("bouquetPhoto", fulfillPhotoFile);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }, [selectedIds, fetcher, fulfillTrackingNumber, fulfillTrackingUrl, fulfillNotify, fulfillPhotoFile]);

  const handlePhotoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setFulfillPhotoFile(null);
    setFulfillPhotoPreview("");
    setFulfillPhotoError("");
    if (!file) return;
    const MAX = 5 * 1024 * 1024;
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setFulfillPhotoError("Only JPEG, PNG, or WebP images are accepted.");
      return;
    }
    if (file.size > MAX) {
      setFulfillPhotoError("File must be 5 MB or smaller.");
      return;
    }
    setFulfillPhotoFile(file);
    setFulfillPhotoPreview(URL.createObjectURL(file));
  };

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    const d = fetcher.data;
    const actionLabel: Record<BulkActionName, { verb: string; ing: string }> = {
      archive: { verb: "archived", ing: "Archive" },
      unarchive: { verb: "unarchived", ing: "Unarchive" },
      cancel: { verb: "queued for cancellation", ing: "Cancel" },
      tagsAdd: { verb: "updated (tags added)", ing: "Add tags" },
      tagsRemove: { verb: "updated (tags removed)", ing: "Remove tags" },
      markFulfilled: { verb: "marked as fulfilled", ing: "Mark as fulfilled" },
    };
    const meta = d.action ? actionLabel[d.action] : null;

    if (d.ok && d.summary && d.summary.ok > 0) {
      const n = d.summary.ok;
      shopify.toast.show(`${n} ${n === 1 ? "order" : "orders"} ${meta?.verb ?? "updated"}.`);
      setSelectedIds(new Set());
      hideModal("modal-archive-orders");
      hideModal("modal-unarchive-orders");
      hideModal("modal-cancel-orders");
      hideModal("modal-add-tags");
      hideModal("modal-remove-tags");
      hideModal("modal-mark-fulfilled");
      setCancelStaffNote("");
      setAddTagsInput("");
      setRemoveTagsInput("");
      setFulfillTrackingNumber("");
      setFulfillTrackingUrl("");
      setFulfillNotify(false);
      setFulfillPhotoFile(null);
      setFulfillPhotoPreview("");
      setFulfillPhotoError("");
    } else if (d.summary && d.summary.failed > 0) {
      const failed = (d.results || []).filter((r) => !r.success);
      const lines = failed
        .slice(0, 3)
        .map((r) => `${r.orderId.split("/").pop()}: ${r.message ?? "Failed"}`)
        .join(" • ");
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
      const okN = d.summary.ok;
      const failN = d.summary.failed;
      const msg =
        okN > 0
          ? `${okN} succeeded, ${failN} failed. ${lines}${more}`
          : `${meta?.ing ?? "Action"} failed for ${failN} ${failN === 1 ? "order" : "orders"}. ${lines}${more}`;
      shopify.toast.show(msg, { isError: true });
      // Keep only failed orders selected so merchant can retry without re-selecting
      setSelectedIds(new Set(failed.map((r) => r.orderId)));
    } else if (d.message) {
      shopify.toast.show(d.message, { isError: true });
    }
    // setSelectedIds is a useState setter from the parent — stable identity,
    // so listing it (required now that it's a prop) never re-fires the effect.
  }, [fetcher.data, fetcher.state, shopify, setSelectedIds]);

  return {
    isSubmitting,
    cancelReason,
    setCancelReason,
    cancelRestock,
    setCancelRestock,
    cancelNotify,
    setCancelNotify,
    cancelStaffNote,
    setCancelStaffNote,
    addTagsInput,
    setAddTagsInput,
    removeTagsInput,
    setRemoveTagsInput,
    fulfillTrackingNumber,
    setFulfillTrackingNumber,
    fulfillTrackingUrl,
    setFulfillTrackingUrl,
    fulfillNotify,
    setFulfillNotify,
    fulfillPhotoPreview,
    fulfillPhotoError,
    handlePhotoChange,
    handleArchive,
    handleUnarchive,
    handleArchiveConfirm,
    handleUnarchiveConfirm,
    handleCancelConfirm,
    handleAddTags,
    handleRemoveTags,
    handleMarkFulfilled,
  };
}

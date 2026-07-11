import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
} from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { BulkActionName, BulkActionResponse } from "../routes/app.orders";

// Which bulk modal is open. Visibility lives in React state (not the DOM),
// so closing on action success is a plain setState — this replaces the old
// s-modal show()/hide()/removeAttribute("open") DOM pokes that could not
// reliably close a command-shown modal (audit S1/S2/S6, B1/B2).
export type BulkModalName =
  | "archive"
  | "unarchive"
  | "cancel"
  | "addTags"
  | "removeTags"
  | "markFulfilled";

// Bulk-action state, submission, modal visibility, and toast/result handling
// for /app/orders. Selection now comes from Polaris useIndexResourceState:
// the hook receives the selected id array plus the two selection callbacks it
// needs (clear on full success, prune to failed ids on partial failure).
export function useBulkActions(
  selectedResources: string[],
  clearSelection: () => void,
  removeSelectedResources: (ids: string[]) => void,
) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<BulkActionResponse>();
  const isSubmitting: boolean = fetcher.state !== "idle";

  // Modal visibility — single source of truth for all six bulk modals.
  const [activeModal, setActiveModal] = useState<BulkModalName | null>(null);
  const openModal = useCallback((name: BulkModalName) => {
    setActiveModal(name);
  }, []);
  const closeModal = useCallback(() => {
    setActiveModal(null);
  }, []);

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

  const submitBulk = useCallback(
    (op: BulkActionName, extras?: Record<string, string>) => {
      if (selectedResources.length === 0) return;
      const fd = new FormData();
      fd.append("_action", op);
      selectedResources.forEach((id) => fd.append("orderId", id));
      if (extras) {
        for (const [k, v] of Object.entries(extras)) fd.append(k, v);
      }
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher, selectedResources],
  );

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
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.append("_action", "markFulfilled");
    selectedResources.forEach((id) => fd.append("orderId", id));
    fd.append("trackingNumber", fulfillTrackingNumber);
    fd.append("trackingUrl", fulfillTrackingUrl);
    fd.append("notifyCustomer", fulfillNotify ? "1" : "0");
    if (fulfillPhotoFile) fd.append("bouquetPhoto", fulfillPhotoFile);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }, [selectedResources, fetcher, fulfillTrackingNumber, fulfillTrackingUrl, fulfillNotify, fulfillPhotoFile]);

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

  // The selection callbacks come from useIndexResourceState, whose returned
  // function identities are not guaranteed stable across renders — read them
  // through refs so the result effect below keys ONLY off fetcher state and
  // can never re-fire (duplicate toast) from a callback identity change.
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;
  const removeSelectedResourcesRef = useRef(removeSelectedResources);
  removeSelectedResourcesRef.current = removeSelectedResources;
  const handledDataRef = useRef<BulkActionResponse | null>(null);

  // REC-6 delayed re-poll: Shopify processes fulfillmentCreate
  // asynchronously, so React Router's automatic post-action revalidation can
  // still read a stale displayFulfillmentStatus — re-poll once more after
  // the eventual-consistency window (~3s).
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const repollTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (repollTimerRef.current !== null) {
        window.clearTimeout(repollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    const d = fetcher.data;

    if (d.action === "markFulfilled" && d.summary && d.summary.ok > 0) {
      if (repollTimerRef.current !== null) {
        window.clearTimeout(repollTimerRef.current);
      }
      repollTimerRef.current = window.setTimeout(() => {
        repollTimerRef.current = null;
        if (revalidatorRef.current.state === "idle") {
          revalidatorRef.current.revalidate();
        }
      }, 3000);
    }
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
      clearSelectionRef.current();
      setActiveModal(null);
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
      // Keep only failed orders selected so merchant can retry without
      // re-selecting: drop every id that succeeded from the selection.
      const succeededIds = (d.results || [])
        .filter((r) => r.success)
        .map((r) => r.orderId);
      if (succeededIds.length > 0) {
        removeSelectedResourcesRef.current(succeededIds);
      }
      setActiveModal(null);
    } else if (d.message) {
      shopify.toast.show(d.message, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  return {
    isSubmitting,
    activeModal,
    openModal,
    closeModal,
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
    handleArchiveConfirm,
    handleUnarchiveConfirm,
    handleCancelConfirm,
    handleAddTags,
    handleRemoveTags,
    handleMarkFulfilled,
  };
}

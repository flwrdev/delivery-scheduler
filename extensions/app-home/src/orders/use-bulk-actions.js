import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { submitOrdersOp } from "./orders-api";

const ACTION_LABEL = {
  archive: { verb: "archived", ing: "Archive" },
  unarchive: { verb: "unarchived", ing: "Unarchive" },
  cancel: { verb: "queued for cancellation", ing: "Cancel" },
  tagsAdd: { verb: "updated (tags added)", ing: "Add tags" },
  tagsRemove: { verb: "updated (tags removed)", ing: "Remove tags" },
  markFulfilled: { verb: "marked as fulfilled", ing: "Mark as fulfilled" },
  markAsPaid: { verb: "marked as paid", ing: "Mark as paid" },
  reschedule: { verb: "rescheduled", ing: "Update delivery slot" },
};

const FULFILL_REPOLL_MS = 3000;

/**
 * Bulk-op submission, modal form state and result toasts for the Orders page.
 * `reload` re-reads the page after every submit; `hideModals` closes the
 * open overlay.
 */
export function useBulkActions({
  selectedIds,
  clearSelection,
  removeSelected,
  reload,
  hideModals,
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastActionResult, setLastActionResult] = useState(null);
  const [activeModal, setActiveModal] = useState(null);

  const [cancelReason, setCancelReason] = useState("CUSTOMER");
  const [cancelRestock, setCancelRestock] = useState(false);
  const [cancelNotify, setCancelNotify] = useState(false);
  const [cancelStaffNote, setCancelStaffNote] = useState("");
  const [addTagsInput, setAddTagsInput] = useState("");
  const [removeTagsInput, setRemoveTagsInput] = useState("");
  const [fulfillTrackingUrl, setFulfillTrackingUrl] = useState("");
  const [fulfillNotify, setFulfillNotify] = useState(false);

  const repollTimerRef = useRef(null);
  useEffect(
    () => () => {
      if (repollTimerRef.current !== null) clearTimeout(repollTimerRef.current);
    },
    [],
  );

  const resetForms = useCallback(() => {
    setActiveModal(null);
    setLastActionResult(null);
    setCancelReason("CUSTOMER");
    setCancelRestock(false);
    setCancelNotify(false);
    setCancelStaffNote("");
    setAddTagsInput("");
    setRemoveTagsInput("");
    setFulfillTrackingUrl("");
    setFulfillNotify(false);
  }, []);

  const closeModal = useCallback(() => {
    hideModals();
    resetForms();
  }, [hideModals, resetForms]);

  const handleResult = useCallback(
    (d) => {
      if (d.action === "markFulfilled" && d.summary && d.summary.ok > 0) {
        if (repollTimerRef.current !== null) clearTimeout(repollTimerRef.current);
        repollTimerRef.current = setTimeout(() => {
          repollTimerRef.current = null;
          reload({ background: true });
        }, FULFILL_REPOLL_MS);
      }
      if (d.action === "reschedule" && d.code === "capacity_override_required") {
        return;
      }
      const meta = d.action ? ACTION_LABEL[d.action] : null;

      if (d.ok && d.summary && d.summary.ok > 0) {
        const n = d.summary.ok;
        shopify.toast.show(`${n} ${n === 1 ? "order" : "orders"} ${meta?.verb ?? "updated"}.`);
        clearSelection();
        closeModal();
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
        const succeededIds = (d.results || []).filter((r) => r.success).map((r) => r.orderId);
        if (succeededIds.length > 0) removeSelected(succeededIds);
        closeModal();
      } else if (d.message) {
        shopify.toast.show(d.message, { isError: true });
      }
    },
    [clearSelection, removeSelected, closeModal, reload],
  );

  const submit = useCallback(
    async (fields) => {
      setIsSubmitting(true);
      try {
        const result = await submitOrdersOp(fields);
        setLastActionResult(result);
        handleResult(result);
        await reload({ background: true });
      } finally {
        setIsSubmitting(false);
      }
    },
    [handleResult, reload],
  );

  const submitBulk = (op, extras = {}) => {
    if (selectedIds.length === 0) return;
    submit({ _action: op, orderId: selectedIds, ...extras });
  };

  const submitReschedule = (orderIds, date, timeSlot, capacityOverride, notifyCustomer = true) => {
    if (orderIds.length === 0 || !date || !timeSlot) return;
    submit({
      _action: "reschedule",
      orderId: orderIds,
      date,
      timeSlot,
      capacityOverride: capacityOverride ? "1" : "0",
      notifyCustomer: notifyCustomer ? "1" : "0",
    });
  };

  const confirmActive = () => {
    switch (activeModal) {
      case "archive":
      case "unarchive":
      case "markAsPaid":
        submitBulk(activeModal);
        break;
      case "cancel":
        submitBulk("cancel", {
          reason: cancelReason,
          restock: cancelRestock ? "1" : "0",
          notifyCustomer: cancelNotify ? "1" : "0",
          staffNote: cancelStaffNote,
        });
        break;
      case "addTags":
        if (addTagsInput.trim()) submitBulk("tagsAdd", { tags: addTagsInput });
        break;
      case "removeTags":
        if (removeTagsInput.trim()) submitBulk("tagsRemove", { tags: removeTagsInput });
        break;
      case "markFulfilled":
        submitBulk("markFulfilled", {
          trackingUrl: fulfillTrackingUrl,
          notifyCustomer: fulfillNotify ? "1" : "0",
        });
        break;
      default:
        break;
    }
  };

  return {
    isSubmitting,
    activeModal,
    openModal: setActiveModal,
    closeModal,
    resetForms,
    lastActionResult,
    submitReschedule,
    confirmActive,
    form: {
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
      fulfillTrackingUrl,
      setFulfillTrackingUrl,
      fulfillNotify,
      setFulfillNotify,
    },
  };
}

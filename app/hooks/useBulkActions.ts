import { useState, useCallback, useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { BulkActionName, BulkActionResponse } from "../routes/app.orders";

// Which bulk modal is open. Visibility lives in React state (not the DOM),
// so closing on action success is a plain setState — this replaces the old
// s-modal show()/hide()/removeAttribute("open") DOM pokes that could not
// reliably close a command-shown modal (audit S1/S2/S6, B1/B2).
// "sendEmail" and "editDetails" are panel-only (single order, own fetcher in
// their own modal) but share this union so the §6 smart-refresh pause covers
// them like every modal — that pause is what keeps a background revalidation
// from landing underneath a half-typed address.
export type BulkModalName =
  | "archive"
  | "unarchive"
  | "cancel"
  | "addTags"
  | "removeTags"
  | "markFulfilled"
  | "markAsPaid"
  | "reschedule"
  | "sendEmail"
  | "editDetails";

const ACTION_LABEL: Record<BulkActionName, { verb: string; ing: string }> = {
  archive: { verb: "archived", ing: "Archive" },
  unarchive: { verb: "unarchived", ing: "Unarchive" },
  cancel: { verb: "queued for cancellation", ing: "Cancel" },
  tagsAdd: { verb: "updated (tags added)", ing: "Add tags" },
  tagsRemove: { verb: "updated (tags removed)", ing: "Remove tags" },
  markFulfilled: { verb: "marked as fulfilled", ing: "Mark as fulfilled" },
  markAsPaid: { verb: "marked as paid", ing: "Mark as paid" },
  reschedule: { verb: "rescheduled", ing: "Update delivery slot" },
};

// Poll shape from /app/orders/bulk-job/:jobId (ADR-22 Phase B) — mirrors
// BulkActionJobStatus in bulk-action-jobs.server.ts.
interface BulkJobPoll {
  found: boolean;
  status?: string;
  action?: BulkActionName;
  totalCount?: number;
  okCount?: number;
  failCount?: number;
  lastError?: string | null;
  results?: Array<{ orderId: string; success: boolean; message?: string }>;
}

export interface ActiveBulkJob {
  jobId: string;
  action: BulkActionName;
  total: number;
}

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

  // Cancel modal form state
  const [cancelReason, setCancelReason] = useState<string>("CUSTOMER");
  const [cancelRestock, setCancelRestock] = useState<boolean>(false);
  const [cancelNotify, setCancelNotify] = useState<boolean>(false);
  const [cancelStaffNote, setCancelStaffNote] = useState<string>("");

  // Tag modal form state
  const [addTagsInput, setAddTagsInput] = useState<string>("");
  const [removeTagsInput, setRemoveTagsInput] = useState<string>("");

  // Mark as fulfilled modal form state
  const [fulfillTrackingUrl, setFulfillTrackingUrl] = useState<string>("");
  const [fulfillNotify, setFulfillNotify] = useState<boolean>(false);
  // Lalamove Order ID (ADR-16) — the real numeric id from the Lalamove app's
  // order detail "Additional info" section, NOT the tracking share-link.
  // Single-order only: applying one courier's id to a multi-order bulk
  // fulfillment would be wrong, so the modal only accepts it when exactly
  // one order is selected (enforced in MarkFulfilledModal + here).
  const [fulfillLalamoveOrderId, setFulfillLalamoveOrderId] = useState<string>("");

  // Modal visibility — single source of truth for all six bulk modals.
  const [activeModal, setActiveModal] = useState<BulkModalName | null>(null);
  const openModal = useCallback((name: BulkModalName) => {
    setActiveModal(name);
  }, []);
  // Closing (Cancel button, backdrop, Esc) resets every modal's form state,
  // not just on a successful submit — otherwise a value typed then
  // cancelled survives into the next time that modal opens, silently
  // attached to whatever's selected then. This matters most for
  // fulfillLalamoveOrderId (ADR-16): a stale id left over from a cancelled
  // submit on order A can get attached to order B's fulfillment the next
  // time the modal opens, misdirecting the auto-Delivered courier
  // correlation to the wrong Shopify order.
  const closeModal = useCallback(() => {
    setActiveModal(null);
    setCancelReason("CUSTOMER");
    setCancelRestock(false);
    setCancelNotify(false);
    setCancelStaffNote("");
    setAddTagsInput("");
    setRemoveTagsInput("");
    setFulfillTrackingUrl("");
    setFulfillNotify(false);
    setFulfillLalamoveOrderId("");
  }, []);

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
  const handleMarkAsPaidConfirm = () => submitBulk("markAsPaid");

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

  // Reschedule targets come in explicitly instead of from selectedResources:
  // the same modal serves the bulk-actions bar (selection) AND the details
  // panel's single-order "Update delivery slot" (an order that may not be
  // selected).
  const submitReschedule = useCallback(
    (
      orderIds: string[],
      date: string,
      timeSlot: string,
      capacityOverride: boolean,
      notifyCustomer: boolean = true,
    ) => {
      if (orderIds.length === 0 || !date || !timeSlot) return;
      const fd = new FormData();
      fd.append("_action", "reschedule");
      orderIds.forEach((id) => fd.append("orderId", id));
      fd.append("date", date);
      fd.append("timeSlot", timeSlot);
      fd.append("capacityOverride", capacityOverride ? "1" : "0");
      fd.append("notifyCustomer", notifyCustomer ? "1" : "0");
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher],
  );

  const handleMarkFulfilled = useCallback(() => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.append("_action", "markFulfilled");
    selectedResources.forEach((id) => fd.append("orderId", id));
    fd.append("trackingUrl", fulfillTrackingUrl);
    fd.append("notifyCustomer", fulfillNotify ? "1" : "0");
    if (selectedResources.length === 1 && fulfillLalamoveOrderId.trim()) {
      fd.append("lalamoveOrderId", fulfillLalamoveOrderId.trim());
    }
    fetcher.submit(fd, { method: "post" });
  }, [
    selectedResources,
    fetcher,
    fulfillTrackingUrl,
    fulfillNotify,
    fulfillLalamoveOrderId,
  ]);

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

  // ── ADR-22 Phase B: background-job mode for large selections ──────────────
  // The action answers { mode: "job", jobId } instead of results; this hook
  // then polls /app/orders/bulk-job/:jobId every 2s and fires the SAME
  // completion handling (toast, selection prune, revalidate) once the job
  // finishes. The job runs server-side regardless — closing the page only
  // loses the toast, never the work.
  const [activeJob, setActiveJob] = useState<ActiveBulkJob | null>(null);
  const jobFetcher = useFetcher<BulkJobPoll>();
  const jobFetcherLoadRef = useRef(jobFetcher.load);
  jobFetcherLoadRef.current = jobFetcher.load;
  const activeJobRef = useRef(activeJob);
  activeJobRef.current = activeJob;
  const handledJobDataRef = useRef<BulkJobPoll | null>(null);

  useEffect(() => {
    if (!activeJob) return;
    const intervalId = window.setInterval(() => {
      jobFetcherLoadRef.current(`/app/orders/bulk-job/${activeJob.jobId}`);
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [activeJob]);

  useEffect(() => {
    const d = jobFetcher.data;
    if (!d || jobFetcher.state !== "idle") return;
    if (!activeJobRef.current) return;
    if (handledJobDataRef.current === d) return;
    handledJobDataRef.current = d;
    // Not found yet (read raced the create) or still running → keep polling;
    // the progress numbers render from jobFetcher.data directly.
    if (!d.found || (d.status !== "done" && d.status !== "failed")) return;

    const action = activeJobRef.current.action;
    setActiveJob(null);
    const results = d.results ?? [];
    const okN = d.okCount ?? results.filter((r) => r.success).length;
    const failN = d.failCount ?? results.filter((r) => !r.success).length;
    const meta = ACTION_LABEL[action];

    // Same REC-6 eventual-consistency re-poll as the inline path.
    if (action === "markFulfilled" && okN > 0) {
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

    if (failN === 0 && okN > 0) {
      shopify.toast.show(`${okN} ${okN === 1 ? "order" : "orders"} ${meta.verb}.`);
      clearSelectionRef.current();
    } else if (failN > 0) {
      const failed = results.filter((r) => !r.success);
      const lines = failed
        .slice(0, 3)
        .map((r) => `${r.orderId.split("/").pop()}: ${r.message ?? "Failed"}`)
        .join(" • ");
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
      const msg =
        okN > 0
          ? `${okN} succeeded, ${failN} failed. ${lines}${more}`
          : `${meta.ing} failed for ${failN} ${failN === 1 ? "order" : "orders"}. ${lines}${more}`;
      shopify.toast.show(msg, { isError: true });
      const succeededIds = results.filter((r) => r.success).map((r) => r.orderId);
      if (succeededIds.length > 0) {
        removeSelectedResourcesRef.current(succeededIds);
      }
    } else {
      // Terminal job failure with nothing processed (e.g. no offline session).
      shopify.toast.show(d.lastError || "Bulk action failed.", { isError: true });
    }
    if (revalidatorRef.current.state === "idle") {
      revalidatorRef.current.revalidate();
    }
  }, [jobFetcher.data, jobFetcher.state, shopify]);

  // Progress numbers for the route's background-job banner.
  const jobProgress =
    activeJob !== null
      ? {
          done:
            jobFetcher.data?.found && jobFetcher.data.status
              ? (jobFetcher.data.okCount ?? 0) + (jobFetcher.data.failCount ?? 0)
              : 0,
          total:
            (jobFetcher.data?.found ? jobFetcher.data.totalCount : null) ??
            activeJob.total,
        }
      : null;

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    const d = fetcher.data;

    // ADR-22 Phase B: a large selection came back as a job to poll, not
    // results — hand off to the poller above.
    if (d.mode === "job" && d.jobId && d.action) {
      setActiveJob({ jobId: d.jobId, action: d.action, total: d.total ?? 0 });
      handledJobDataRef.current = null;
      shopify.toast.show(d.message ?? "Processing in the background…");
      closeModal();
      return;
    }

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
    // The capacity warn+override round-trip (REC-4) is not a result: the
    // reschedule modal stays open and re-renders as the explicit confirm
    // step, so no toast and no modal close here.
    if (d.action === "reschedule" && d.code === "capacity_override_required") {
      return;
    }
    const meta = d.action ? ACTION_LABEL[d.action] : null;

    if (d.ok && d.summary && d.summary.ok > 0) {
      const n = d.summary.ok;
      shopify.toast.show(
        `${n} ${n === 1 ? "order" : "orders"} ${meta?.verb ?? "updated"}.`,
      );
      clearSelectionRef.current();
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
      // Keep only failed orders selected so merchant can retry without
      // re-selecting: drop every id that succeeded from the selection.
      const succeededIds = (d.results || [])
        .filter((r) => r.success)
        .map((r) => r.orderId);
      if (succeededIds.length > 0) {
        removeSelectedResourcesRef.current(succeededIds);
      }
      closeModal();
    } else if (d.message) {
      shopify.toast.show(d.message, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify, closeModal]);

  return {
    isSubmitting,
    activeModal,
    openModal,
    closeModal,
    // ADR-22 Phase B: non-null while a background bulk job runs — drives the
    // route's progress banner.
    activeJob,
    jobProgress,
    // Raw last action response — the reschedule modal reads the
    // capacity_override_required round-trip from here.
    lastActionResult: fetcher.data ?? null,
    submitReschedule,
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
    fulfillLalamoveOrderId,
    setFulfillLalamoveOrderId,
    handleArchiveConfirm,
    handleUnarchiveConfirm,
    handleMarkAsPaidConfirm,
    handleCancelConfirm,
    handleAddTags,
    handleRemoveTags,
    handleMarkFulfilled,
  };
}

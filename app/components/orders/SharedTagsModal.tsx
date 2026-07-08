import { useEffect, useRef, type ElementRef } from "react";
import { tagDisplayLabel } from "../../lib/order-utils";

// Shared row-level tags/attributes modal — one instance reused by every table
// row's "+N" button. JSX moved verbatim from app.orders.tsx Extension().
// The open trigger is a counter prop: each increment opens the modal via a
// ref to the s-modal element (replaces the former document.getElementById
// poke in the route; same effect timing, id "modal-tags-shared" unchanged so
// the close button's commandFor keeps working).
export interface SharedTagsModalProps {
  tags: string[];
  openTrigger: number;
}

type SModalElement = ElementRef<"s-modal"> & {
  show?: () => void;
  setAttribute: (name: string, value: string) => void;
};

export function SharedTagsModal({ tags, openTrigger }: SharedTagsModalProps) {
  const modalRef = useRef<SModalElement | null>(null);

  useEffect(() => {
    if (openTrigger > 0) {
      const el = modalRef.current;
      if (el && typeof el.show === "function") el.show();
      else el?.setAttribute("open", "");
    }
  }, [openTrigger]);

  return (
    <s-modal
      ref={modalRef}
      id="modal-tags-shared"
      heading="Attributes"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="inline" gap="small">
          {tags.map((tag) => (
            <s-chip key={tag}>{tagDisplayLabel(tag)}</s-chip>
          ))}
        </s-stack>
      </s-box>
      <s-button
        slot="primary-action"
        commandFor="modal-tags-shared"
        command="--hide"
      >
        Close
      </s-button>
    </s-modal>
  );
}

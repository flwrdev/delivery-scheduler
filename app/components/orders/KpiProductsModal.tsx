// "Items to prepare" modal, opened declaratively by the Orders KPI card
// button (commandFor="modal-kpi-products"). JSX moved verbatim from
// app.orders.tsx Extension(); id unchanged so the trigger keeps working.
export interface KpiProductsModalProps {
  kpiProducts: [string, number][];
}

export function KpiProductsModal({ kpiProducts }: KpiProductsModalProps) {
  return (
    <s-modal id="modal-kpi-products" heading="Items to prepare" size="small">
      <s-box padding="base">
        <s-stack direction="block" gap="small">
          {kpiProducts.length === 0 ? (
            <s-text color="subdued">No products found.</s-text>
          ) : (
            <s-stack direction="block" gap="small-100">
              {kpiProducts.map(([name, qty], idx) => (
                <s-stack
                  key={idx}
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text>{name}</s-text>
                  <s-text type="strong">× {qty}</s-text>
                </s-stack>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-box>
      <s-button
        slot="primary-action"
        commandFor="modal-kpi-products"
        command="--hide"
      >
        Close
      </s-button>
    </s-modal>
  );
}

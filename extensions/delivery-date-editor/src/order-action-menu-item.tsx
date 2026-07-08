import { reactExtension, useOrder } from '@shopify/ui-extensions-react/customer-account';

export default reactExtension(
  'customer-account.order.action.menu-item.render',
  () => <RescheduleMenuItem />,
);

function RescheduleMenuItem() {
  const order = useOrder() as
    | (Record<string, unknown> & { canceledAt?: string | null })
    | null
    | undefined;
  // Hide for cancelled orders — rescheduling a cancelled order makes no sense.
  if (order?.canceledAt) return null;
  return <s-button>Reschedule Delivery</s-button>;
}

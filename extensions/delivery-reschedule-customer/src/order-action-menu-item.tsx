export default async function renderRescheduleMenuItem() {
  // Keep the menu item intentionally dumb; the modal owns all delivery validation,
  // schedule loading, and submission logic once Shopify opens the action.
  const button = document.createElement('s-button');
  button.textContent = 'Reschedule Delivery';
  document.body.replaceChildren(button);
}
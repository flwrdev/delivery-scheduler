import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router } from "preact-iso";

import OrdersPage from "./pages/OrdersPage";
import SettingsPage from "./pages/SettingsPage";

export default async () => {
  render(<App />, document.body);
};

function App() {
  return (
    <LocationProvider>
      <ErrorBoundary>
        <Router>
          <Route path="/" component={OrdersPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route default component={OrdersPage} />
        </Router>
      </ErrorBoundary>
    </LocationProvider>
  );
}

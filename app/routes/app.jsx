import {
  Link,
  Outlet,
  redirect,
  useLoaderData,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  buildEmbeddedAppPath,
  buildEmbeddedBootstrapPath,
} from "../lib/embedded-route";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  const shop = session?.shop ?? url.searchParams.get("shop");
  const isEmbeddedEntry = url.pathname === "/app" || url.pathname === "/app/";

  if (!host && shop && !isEmbeddedEntry) {
    return redirect(
      buildEmbeddedBootstrapPath(url.pathname, url.searchParams, shop),
    );
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const [searchParams] = useSearchParams();
  const ordersHref = buildEmbeddedAppPath("/app/orders", searchParams);
  const schedulerHref = buildEmbeddedAppPath("/app/scheduler", searchParams);
  const scheduleRulesHref = buildEmbeddedAppPath(
    "/app/schedule-rules",
    searchParams,
  );

  return (
    <AppProvider embedded apiKey={apiKey}>
      <ui-nav-menu>
        <Link to={ordersHref} rel="home">Orders</Link>
        <Link to={schedulerHref}>Scheduler</Link>
        <Link to={scheduleRulesHref}>Schedule rules</Link>
      </ui-nav-menu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

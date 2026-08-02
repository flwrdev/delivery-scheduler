// Messenger operations page — phase 7: per-thread bot Pause/Resume (manual
// human takeover + handback); phase 8: Shopify orders listing (tag:messenger,
// READ-ONLY) + Messenger profile setup (Get Started / Ice Breakers /
// Persistent Menu, merchant-triggered).
//
// Write surfaces dito: Neon MessengerThread flags (pause/resume) at ang
// outbound Messenger Profile API POST (setupProfile) — ZERO Shopify order
// writes; the orders section is a plain Admin GraphQL read. Per ADR-11, the
// action always answers 200 + { ok, ... }, and a loader-side Graph failure
// degrades to an error banner instead of crashing the page.
//
// Log hygiene: psids and statuses only — never message text.

import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import {
  getMessengerProfile,
  setMessengerProfile,
} from "../services/messenger-profile.server";
import { authenticate } from "../shopify.server";

const THREAD_LIMIT = 100;
const ORDER_LIMIT = 25;

interface ThreadRowData {
  psid: string;
  lastCustomerAt: string | null;
  humanControl: boolean;
  humanControlAt: string | null;
}

interface MessengerOrderRowData {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  total: string;
  customerName: string;
  deliveryDate: string;
  deliveryTime: string;
  adminUrl: string;
}

type ProfileStatus = "set" | "not_set" | "unknown";

// READ-ONLY listing of Shopify orders born sa Messenger ordering flow — the
// draft order carries the `messenger` tag (phase 6) and the tag survives onto
// the completed order.
const MESSENGER_ORDERS_QUERY = `#graphql
  query MessengerTaggedOrders($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          displayName
        }
        shippingAddress {
          name
        }
        customAttributes {
          key
          value
        }
      }
    }
  }
`;

interface OrderNode {
  id?: string;
  name?: string;
  createdAt?: string;
  displayFinancialStatus?: string | null;
  currentTotalPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string } | null;
  } | null;
  customer?: { displayName?: string | null } | null;
  shippingAddress?: { name?: string | null } | null;
  customAttributes?: Array<{ key?: string; value?: string | null }> | null;
}

function customAttribute(node: OrderNode, key: string): string {
  return node.customAttributes?.find((attr) => attr.key === key)?.value ?? "";
}

function toOrderRow(node: OrderNode): MessengerOrderRowData | null {
  if (!node.id || !node.name) {
    return null;
  }
  const numericId = node.id.split("/").pop() || node.id;
  const money = node.currentTotalPriceSet?.shopMoney;
  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt ?? "",
    financialStatus: node.displayFinancialStatus ?? "",
    total: money?.amount ? `${money.currencyCode === "PHP" ? "₱" : `${money.currencyCode ?? ""} `}${money.amount}` : "",
    customerName: node.customer?.displayName ?? node.shippingAddress?.name ?? "",
    deliveryDate: customAttribute(node, "Delivery Date"),
    deliveryTime: customAttribute(node, "Delivery Time"),
    // Same idiom as OrderDetailsPanel: shopify://admin deep link resolved by
    // App Bridge inside the embedded iframe.
    adminUrl: `shopify://admin/orders/${numericId}`,
  };
}

export const loader = async ({ request }: { request: Request }) => {
  const { admin } = await authenticate.admin(request);

  const threads = await prisma.messengerThread.findMany({
    orderBy: { updatedAt: "desc" },
    take: THREAD_LIMIT,
    select: {
      psid: true,
      lastCustomerAt: true,
      humanControl: true,
      humanControlAt: true,
    },
  });

  interface ThreadRecord {
    psid: string;
    lastCustomerAt: Date | null;
    humanControl: boolean;
    humanControlAt: Date | null;
  }

  // Shopify orders listing (phase 8) — READ-ONLY, degrade to a banner on any
  // upstream failure (walang crash; the thread section must keep working).
  let orders: MessengerOrderRowData[] = [];
  let ordersError: string | null = null;
  try {
    const response = await admin.graphql(MESSENGER_ORDERS_QUERY, {
      variables: { first: ORDER_LIMIT, query: "tag:messenger" },
    });
    const body = (await response.json()) as {
      data?: { orders?: { nodes?: OrderNode[] } };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) {
      ordersError = "Hindi na-load ang Messenger orders mula sa Shopify. Subukan i-refresh.";
      console.warn(
        `[messenger-threads] orders query returned errors: ${body.errors
          .map((e) => e.message ?? "unknown")
          .join("; ")}`,
      );
    } else {
      orders = (body.data?.orders?.nodes ?? [])
        .map(toOrderRow)
        .filter((row): row is MessengerOrderRowData => row !== null);
    }
  } catch (error) {
    ordersError = "Hindi na-load ang Messenger orders mula sa Shopify. Subukan i-refresh.";
    console.warn(
      `[messenger-threads] orders query failed: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  // Messenger profile status (phase 8) — best-effort; failure = "unknown".
  let profileStatus: ProfileStatus = "unknown";
  const profile = await getMessengerProfile();
  if (profile.ok) {
    profileStatus =
      profile.profile.hasGetStarted &&
      profile.profile.hasIceBreakers &&
      profile.profile.hasPersistentMenu
        ? "set"
        : "not_set";
  }

  return {
    threads: (threads as ThreadRecord[]).map(
      (thread): ThreadRowData => ({
        psid: thread.psid,
        lastCustomerAt: thread.lastCustomerAt?.toISOString() ?? null,
        humanControl: thread.humanControl,
        humanControlAt: thread.humanControlAt?.toISOString() ?? null,
      }),
    ),
    orders,
    ordersError,
    profileStatus,
  };
};

export const action = async ({ request }: { request: Request }) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Phase 8: merchant-triggered Messenger profile setup. Outbound Graph call
  // only — never throws; ADR-11 pa rin ang response contract.
  if (intent === "setupProfile") {
    const result = await setMessengerProfile();
    if (result.ok) {
      console.log("[messenger-threads] messenger profile set");
      return { ok: true as const, intent };
    }
    console.warn(`[messenger-threads] profile setup failed: ${result.error}`);
    return { ok: false as const, errors: [result.error] };
  }

  const psid = String(form.get("psid") ?? "");

  if (!psid) {
    return { ok: false as const, errors: ["Walang thread na napili."] };
  }
  if (intent !== "pause" && intent !== "resume") {
    return { ok: false as const, errors: ["Hindi kilalang action."] };
  }

  try {
    if (intent === "pause") {
      // Pre-emptive manual takeover: mute the bot now. humanControlAt starts
      // the auto-handback window, same as an operator echo would.
      await prisma.messengerThread.update({
        where: { psid },
        data: { humanControl: true, humanControlAt: new Date() },
      });
    } else {
      // Manual handback. disclosedBot=false forces the bot to re-disclose on
      // its next reply — Meta policy after a human handoff.
      await prisma.messengerThread.update({
        where: { psid },
        data: { humanControl: false, humanControlAt: null, disclosedBot: false },
      });
    }
    console.log(`[messenger-threads] ${intent} psid=${psid}`);
    return { ok: true as const, intent, psid };
  } catch (error) {
    // ADR-11: never bubble a raw 5xx through the embedded fetcher.
    console.error(
      `[messenger-threads] ${intent} failed for psid=${psid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return { ok: false as const, errors: ["Hindi na-update ang thread. Subukan ulit."] };
  }
};

function formatManila(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ThreadRow({ thread, index }: { thread: ThreadRowData; index: number }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  // Optimistic status while the toggle is in flight.
  const paused =
    fetcher.formData != null
      ? fetcher.formData.get("intent") === "pause"
      : thread.humanControl;

  return (
    <IndexTable.Row id={thread.psid} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {thread.psid}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatManila(thread.lastCustomerAt)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={paused ? "attention" : "success"}>
          {paused ? "Human — bot paused" : "Bot active"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{paused ? formatManila(thread.humanControlAt) : "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <Button
          size="slim"
          loading={busy}
          onClick={() =>
            fetcher.submit(
              { intent: paused ? "resume" : "pause", psid: thread.psid },
              { method: "post" },
            )
          }
        >
          {paused ? "Resume bot" : "Pause bot"}
        </Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

function ProfileSetupCard({ profileStatus }: { profileStatus: ProfileStatus }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) {
      return;
    }
    if (fetcher.data.ok) {
      shopify.toast.show("Na-setup na ang Messenger profile.");
    } else {
      shopify.toast.show(
        (fetcher.data as { errors?: string[] }).errors?.[0] ??
          "Hindi na-setup ang Messenger profile. Subukan ulit.",
        { isError: true },
      );
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const statusBadge =
    profileStatus === "set" ? (
      <Badge tone="success">Naka-setup</Badge>
    ) : profileStatus === "not_set" ? (
      <Badge tone="attention">Hindi pa naka-setup</Badge>
    ) : (
      <Badge>Hindi ma-check</Badge>
    );

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Messenger profile
          </Text>
          {statusBadge}
        </InlineStack>
        <Text as="p" variant="bodyMd" tone="subdued">
          Ise-set nito ang Get Started button, ang apat na greeting questions
          (ice breakers), at ang persistent menu ng page — isang beses lang
          kailangan (pwedeng ulitin para i-update).
        </Text>
        <InlineStack>
          <Button
            loading={busy}
            onClick={() => fetcher.submit({ intent: "setupProfile" }, { method: "post" })}
          >
            I-setup ang Messenger profile
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function OrderRow({ order, index }: { order: MessengerOrderRowData; index: number }) {
  return (
    <IndexTable.Row id={order.id} position={index}>
      <IndexTable.Cell>
        <Link url={order.adminUrl} removeUnderline>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {order.name}
          </Text>
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatManila(order.createdAt || null)}</IndexTable.Cell>
      <IndexTable.Cell>{order.customerName || "—"}</IndexTable.Cell>
      <IndexTable.Cell>{order.deliveryDate || "—"}</IndexTable.Cell>
      <IndexTable.Cell>{order.deliveryTime || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        {order.financialStatus ? <Badge>{order.financialStatus}</Badge> : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>{order.total || "—"}</IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function MessengerThreadsPage() {
  const { threads, orders, ordersError, profileStatus } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Messenger" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Ang pag-reply mula sa Business Suite (phone) ay awtomatikong
              nagpa-pause sa bot para sa thread na iyon. Dito manual ang
              pause/resume; pag-resume, magdi-disclose ulit ang bot na
              automated ito.
            </Banner>
            <Card padding="0">
              {threads.length === 0 ? (
                <EmptyState
                  heading="Wala pang Messenger conversations"
                  image=""
                >
                  <p>
                    Lalabas dito ang mga thread sa sandaling may mag-message sa
                    page.
                  </p>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: "thread", plural: "threads" }}
                  itemCount={threads.length}
                  selectable={false}
                  headings={[
                    { title: "Customer (PSID)" },
                    { title: "Last customer message" },
                    { title: "Bot status" },
                    { title: "Human since" },
                    { title: "Action" },
                  ]}
                >
                  {threads.map((thread: ThreadRowData, index: number) => (
                    <ThreadRow key={thread.psid} thread={thread} index={index} />
                  ))}
                </IndexTable>
              )}
            </Card>
            {ordersError ? (
              <Banner tone="critical" title="Messenger orders">
                {ordersError}
              </Banner>
            ) : null}
            <Card padding="0">
              {orders.length === 0 ? (
                <EmptyState heading="Wala pang orders galing sa Messenger" image="">
                  <p>
                    Lalabas dito ang mga Shopify order na may tag na
                    &quot;messenger&quot; — ang mga order na ginawa ng bot sa
                    chat.
                  </p>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: "order", plural: "orders" }}
                  itemCount={orders.length}
                  selectable={false}
                  headings={[
                    { title: "Order" },
                    { title: "Created" },
                    { title: "Customer" },
                    { title: "Delivery Date" },
                    { title: "Delivery Time" },
                    { title: "Payment" },
                    { title: "Total" },
                  ]}
                >
                  {orders.map((order: MessengerOrderRowData, index: number) => (
                    <OrderRow key={order.id} order={order} index={index} />
                  ))}
                </IndexTable>
              )}
            </Card>
            <ProfileSetupCard profileStatus={profileStatus} />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

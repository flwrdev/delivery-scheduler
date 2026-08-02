// Messenger threads — phase-7 minimal version: per-thread bot Pause/Resume
// (manual human takeover + handback, master doc "Human takeover and handback").
//
// Conversation-only page: reads/writes the Neon MessengerThread flags and
// NOTHING else — no Shopify order reads or writes (the Shopify-orders listing
// filtered by the `messenger` tag is phase 8, deliberately not built here).
// Per ADR-11, the action always answers 200 + { ok, ... }.
//
// Log hygiene: psids and statuses only — never message text.

import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const THREAD_LIMIT = 100;

interface ThreadRowData {
  psid: string;
  lastCustomerAt: string | null;
  humanControl: boolean;
  humanControlAt: string | null;
}

export const loader = async ({ request }: { request: Request }) => {
  await authenticate.admin(request);

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

  return {
    threads: (threads as ThreadRecord[]).map(
      (thread): ThreadRowData => ({
        psid: thread.psid,
        lastCustomerAt: thread.lastCustomerAt?.toISOString() ?? null,
        humanControl: thread.humanControl,
        humanControlAt: thread.humanControlAt?.toISOString() ?? null,
      }),
    ),
  };
};

export const action = async ({ request }: { request: Request }) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
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

export default function MessengerThreadsPage() {
  const { threads } = useLoaderData<typeof loader>();

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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

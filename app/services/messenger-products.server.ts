// RENAMED 2026-08-24 → agent-products.server.ts. Product search serves every
// agent channel (Messenger carousel, web product cards), not just Meta — the
// old name kept reading as Meta-only. This shim keeps the old import path
// alive; new code imports from "./agent-products.server".
export * from "./agent-products.server";

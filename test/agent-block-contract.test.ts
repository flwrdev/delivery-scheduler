// AgentBlock renderer contract (2026-08-24).
//
// THE PROBLEM THIS GUARDS: the neutral AgentBlock vocabulary
// (app/services/agent-channel.ts) is rendered by THREE independent surfaces
// that share no code — the Messenger adapter (quick replies / carousel), the
// customer-account extension (Preact + s-* components), and the storefront
// widget (hand-written vanilla JS). Adding a block type to the union and
// wiring it into only one or two of them compiles clean and fails silently in
// production (the un-updated renderer just drops the block). This test greps
// all three so the miss happens HERE instead.
//
// If you are reading this because it failed: you added (or renamed) a block
// type in agent-channel.ts. Update ALL of:
//   1. app/services/messenger-agent.server.ts  (AgentBlock -> Meta primitives)
//   2. extensions/support-chat/src/SupportChat.jsx        (BlockView switch)
//   3. extensions/storefront-chat-widget/assets/storefront-chat-widget.js
//      (renderBlock switch)
// ...or, if a renderer genuinely must not handle the type, add a documented
// exemption below — a conscious decision, not a silent drop.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

// Parse the union member type names straight out of the AgentBlock source so
// the test can never drift from the real vocabulary.
function agentBlockTypes(): string[] {
  const source = read("app", "services", "agent-channel.ts");
  // Capture up to the next export — the union body itself contains `;` line
  // separators inside its multi-line members.
  const union = source.match(/export type AgentBlock =([\s\S]*?)\nexport /);
  expect(union, "AgentBlock union not found in agent-channel.ts").toBeTruthy();
  const types = [...union![1].matchAll(/\{\s*type:\s*"(\w+)"/g)].map((match) => match[1]);
  expect(types.length).toBeGreaterThanOrEqual(6);
  return types;
}

// type -> renderers that DELIBERATELY do not handle it, with the reason.
const EXEMPTIONS: Record<string, string[]> = {
  // Messenger has no card UI for a standalone order-status block — the agent
  // reads the status into the text reply there, and no emitter produces an
  // "order" block on the Messenger channel today. Wiring it up is a product
  // decision; remove this exemption when that decision is made.
  order: ["messenger"],
};

describe("AgentBlock renderer contract — every block type has a handler on every surface", () => {
  const types = agentBlockTypes();

  const renderers: Array<{ name: string; source: string; pattern: (type: string) => RegExp }> = [
    {
      name: "messenger",
      source: read("app", "services", "messenger-agent.server.ts"),
      // The adapter narrows with `block.type === "<type>"` find-predicates.
      pattern: (type) => new RegExp(`type === "${type}"`),
    },
    {
      name: "customer-account (SupportChat.jsx)",
      source: read("extensions", "support-chat", "src", "SupportChat.jsx"),
      pattern: (type) => new RegExp(`case '${type}'`),
    },
    {
      name: "storefront widget",
      source: read(
        "extensions",
        "storefront-chat-widget",
        "assets",
        "storefront-chat-widget.js",
      ),
      pattern: (type) => new RegExp(`case "${type}"`),
    },
  ];

  for (const renderer of renderers) {
    it(`${renderer.name} handles every non-exempt block type`, () => {
      for (const type of types) {
        if (EXEMPTIONS[type]?.some((slug) => renderer.name.startsWith(slug))) {
          continue;
        }
        expect(
          renderer.pattern(type).test(renderer.source),
          `"${type}" block has no handler in the ${renderer.name} renderer — see the header of this test for the update checklist`,
        ).toBe(true);
      }
    });
  }

  it("exemptions only name real block types (stale exemptions rot the contract)", () => {
    for (const exemptType of Object.keys(EXEMPTIONS)) {
      expect(types).toContain(exemptType);
    }
  });
});

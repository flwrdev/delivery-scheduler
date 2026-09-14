// PreToolUse guard (Bash) — technical safeguard for the 2026-08-01 Neon
// incident (docs/known-issues.md, docs/). This repo
// shares ONE Neon database between dev and prod (confirmed via forensic
// audit 2026-08-17), so any `--shadow-database-url` use here is inherently
// unsafe — there is no throwaway DB to point it at. `prisma migrate dev`
// carries the same risk (it manages its own implicit shadow database).
// Blocks BEFORE the command ever runs, regardless of which session/agent
// issues it — documentation alone (the known-issues.md STANDING RULE)
// already existed and did not stop this from happening once; this hook is
// the enforcement layer requested to sit on top of it.
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(data).tool_input?.command || "";
  } catch {
    // Malformed input — nothing to block on, let it through.
  }

  const hasShadowFlag = /--shadow-database-url/.test(command);
  const hasMigrateDev = /prisma[^&|;]*\bmigrate\s+dev\b/.test(command);

  if (!hasShadowFlag && !hasMigrateDev) {
    process.stdout.write("{}");
    return;
  }

  const reason =
    "BLOCKED — this command matches the exact pattern that wiped production Neon on 2026-08-01 (see docs/known-issues.md). " +
    "This repo shares ONE Neon database between dev and prod — there is no safe --shadow-database-url target here, and " +
    "`prisma migrate dev` carries the same risk (implicit shadow database). Hand-write the migration SQL instead " +
    "(see any folder under prisma/migrations/ for the pattern), then run `npx prisma migrate deploy` " +
    "(`npm run setup`) to apply it.";

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      systemMessage: reason,
    }),
  );
});

# Last Call agent instructions

Last Call ($LAST) is a NEAR memecoin with a daily community check-in game, built for NEAR
HACKATHON 2026. Submission target: **14 November 2026, 12:00 UTC** (hard deadline 23:59 UTC).

## Sources of truth

- Plan of record: `docs/plans/Last Call — план для разработчика.md`. Section 4 (contract interface
  and formulas) is the contract between Rust and TypeScript. When an interface, formula, or
  parameter changes, update that document first, then the code.
- Work state: `docs/tasks/items/LC-NNN-*.md`; each task's frontmatter `status` is authoritative.
- Task-board contract and commands: `docs/tasks/README.md`.
- Reusable workflow: `.claude/skills/managing-last-call-work/SKILL.md`.

`docs/` is local working material and is not committed. On a checkout without `docs/`, there is no
task board: follow `README.md` and skip the work cycle below.

Chat history is never authoritative. Decisions and evidence live in the task file or the plan.

## Work cycle

1. Run `bun docs/tasks/tasks.ts check`, then `bun docs/tasks/tasks.ts promote --mvp`, before
   product work.
2. Work on the task named by the user. If none is named, select it with
   `bun docs/tasks/tasks.ts next --mvp`.
3. Read the task, its dependencies, and the plan sections it references.
4. Claim it before editing product code:
   `bun docs/tasks/tasks.ts set-status LC-NNN in-progress --owner "claude"`.
5. Stay within the task scope. Record newly discovered work as a separate task instead of silently
   broadening the current one.
6. Run the task's verification and the repository check. Update acceptance checkboxes,
   `Completion evidence`, and `Handoff` with exact, reproducible evidence.
7. Set complete implementation to `review`. The implementer never approves its own work: the user or
   an independent reviewer with fresh context appends review evidence and runs
   `set-status LC-NNN done --reviewer "name"`, or returns the task. Run `promote --mvp` afterwards.
8. When blocked, write a durable handoff first, then use
   `set-status ... blocked --reason ... --unblock ...`. End every session with `check` passing.

Never edit lifecycle metadata by hand; `set-status` keeps status, owner, reviewer, blocker metadata,
and dates validated and atomic.

## Staged delivery

- The project is built in stages agreed with the user. Do not start a stage, or a task whose scope
  the user has not seen, without their approval.
- Visual design and the check-in interaction are open decisions. Notify the user before a task first
  needs a concrete design or interaction decision. Until a direction is approved, build a neutral
  functional UI and spend no time on unsolicited visual polish.
- Before optional work expected to take more than about 15 minutes, ask. State the purpose, a
  realistic time range, what deferring it costs, and a cheaper alternative when one exists.
- The plan's kill-switches and cut order (plan section 9) decide what is dropped when time runs
  short. Surface a kill-switch condition as soon as it is met instead of working around it.
- The approved plan is the default, not a reason to hide a materially simpler, safer, or cheaper
  option. Surface it with its trade-offs; do not adopt it silently.

## Verifying material

- Do not claim success from prose alone. Report the commands that were run and their results.
  Never invent evidence; check an acceptance criterion only after its evidence exists.
- Anything the plan marks as unverified is a hypothesis. Confirm it with a focused reproducible
  test before building on it, and record the result in the task's `Completion evidence`.
- For contract-interface, signature, key-handling, relayer, and dependency decisions, review
  current primary sources first: NEPs and official NEAR documentation, official package
  documentation and registries, release and security notes, and upstream repositories with clear
  provenance.
- Community posts and forums may suggest questions or failure modes to investigate. Never cite
  them as evidence, and never adopt a consequential claim until an authoritative source and a
  reproducible test confirm it.
- Record the sources consulted, the conclusion, and the resulting design or test decision in
  `Completion evidence`.
- TypeScript that mirrors contract logic must be proven against the contract (test vectors, golden
  traces, or the sandbox), not against its own expectations.

## Architecture guardrails

- Bun is the runtime and package manager. The web app and its backend are one Next.js project in
  `web/` (App Router, route handlers for the server side), run through Bun.
- For Next.js, read the version-matched documentation shipped with the package in
  `web/node_modules/next/dist/docs/` before using an API. Next's own generated agent rules are
  disabled (`agentRules: false`) because this file governs agents.
- Commands, from the repository root: `bun run dev` (app and backend on one port), `bun run build`,
  and `bun run check` (Biome, type checking, tests). `web/` must declare `@types/node`; without it
  `next build` stalls trying to install it through npm.
- The contract in `contract/` is written by the Rust developer. Do not write or change contract
  code; propose interface changes through the plan.
- The contract is the source of game state. The backend relays and reads; it never becomes an
  authority the game depends on. Direct contract calls must keep working without the backend.
- Validate untrusted input at every boundary: route handlers, RPC responses, wallet responses.
- Secrets (the relayer key, sandbox keys) live only in environment variables. Never put them in
  the repository, task text, command arguments, or client bundles.
- Wallet access and anything touching `window` stays in client components.
- Keep contract-mirroring logic (formulas, NEP-413 payloads) pure and independent of Next.js so
  tests and scripts can import it.

## Dependencies

- Add a package only when the platform, Bun, or Next.js does not already provide the behavior.
- Use the latest stable compatible release with an exact version: no `^`, `~`, `latest`, or ranges.
  `workspace:*` is the exception for internal packages. `bun.lock` is the only lockfile.
- Before installing, confirm the registry entry points to the expected official repository and
  publisher, and check for unexpected install-time scripts.
- Verify the API you intend to use against the package's current official documentation, not
  memory. Record package, version, and source in the task evidence.

## Repository discipline

- Preserve unrelated and pre-existing changes.
- Add focused tests with the implementation. Colocate unit tests with the code they verify.
- Keep generated artifacts out of version control, except those the plan requires to be committed.
- Work in the current checkout and branch. Do not create a worktree unless the user asks.
- Do not commit, stage, push, or open a pull request unless the user explicitly asks. After a
  task, leave changes in the working tree and propose a commit message that includes the task ID
  and its exact title, for example:
  `feat(web): scaffold the Next.js app [LC-001: Bootstrap the workspace and the web app]`.

## Context and compute discipline

- Treat the selected task, its dependencies, and its cited plan sections as the working set. Do
  not read the whole plan or unchanged files without a concrete need.
- Keep connected implementation in the primary agent. Use a subagent only for the independent
  review that closes a task, or when the user asks. Give the reviewer the code and the task, not
  your conclusions.
- Run focused checks while implementing. Run the full repository check once after the final patch
  and repeat it only when a later change makes that evidence stale.
- Keep tool output bounded: summarize passing checks, expand only failing diagnostics.
- Leave no stray processes behind. Stop the test, check, and build processes you started. Leave
  dev servers and the sandbox running only when the user asked for them.
  `.claude/hooks/kill-stale-test-processes.sh` (Stop and SessionEnd hooks) also stops this
  repository's test and check runs older than 10 minutes.

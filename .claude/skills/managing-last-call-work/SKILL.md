---
name: managing-last-call-work
description: Use when starting, resuming, blocking, handing off, reviewing, or completing Last Call implementation tasks, especially when task state must stay consistent across sessions.
---

# Managing Last Call Work

The task board under `docs/tasks/` is the durable coordination layer. Every task has one stable
path under `docs/tasks/items/`; its frontmatter `status` is authoritative. `docs/tasks/tasks.ts` is
the only supported way to change lifecycle state.

## Start or resume work

1. Read `AGENTS.md` and `docs/tasks/README.md`.
2. Run `bun docs/tasks/tasks.ts check`. Diagnose failures before product work; do not rewrite
   unrelated user state.
3. Run `bun docs/tasks/tasks.ts promote --mvp` to open newly dependency-ready work. Omit `--mvp`
   only when the user explicitly wants work outside the submission scope.
4. If no task ID was requested, run `bun docs/tasks/tasks.ts next --mvp`.
5. Read the selected task, confirm its dependencies are `done`, and read the plan sections it
   references.
6. Confirm the user has approved the stage this task belongs to. If the task needs a visual design
   or check-in interaction decision that has not been made, ask before building.
7. Claim it before editing product code:

   ```bash
   bun docs/tasks/tasks.ts set-status LC-NNN in-progress --owner "claude"
   ```

Never edit lifecycle metadata manually. If a claim fails because state changed, run `check` and
`next` again.

## Execute and record evidence

- Work only inside the task's scope. Create a follow-up task instead of silently expanding scope.
- Treat acceptance criteria as the contract and `Verification` as the minimum check.
- Follow "Verifying material" in `AGENTS.md`: primary sources for consequential decisions, a
  reproducible test for anything the plan marks unverified, and no invented evidence.
- Before handoff, update checkboxes, `Completion evidence`, and `Handoff` with exact commands,
  results, changed areas, risks, and the next action.

## Change state

Set `review` only when every criterion is checked and evidence is durable:

```bash
bun docs/tasks/tasks.ts set-status LC-NNN review
```

The implementer stops at `review`. The reviewer is the user or one independent subagent with fresh
context that receives the task file and the changed code, not the implementer's conclusions. The
reviewer reruns the relevant checks, appends the result to `Completion evidence`, and then runs
`set-status LC-NNN done --reviewer "reviewer-name"`, or returns the task to `in-progress` with a
concrete handoff. The CLI rejects a reviewer equal to the owner.

When blocked, first write a durable `Handoff`: attempts, current state, redacted errors, remaining
work, and the first action after unblocking. Never store keys, tokens, or secret-bearing output in
a task or in command arguments. Then run:

```bash
bun docs/tasks/tasks.ts set-status LC-NNN blocked \
  --reason "specific blocking condition" \
  --unblock "observable condition that permits resuming"
```

After `done`, run `promote --mvp` so newly unblocked tasks become claimable. Run `check` after every
state change and at session end.

## Finish

Leave changes uncommitted and give the user a proposed commit message containing the task ID and
its exact title. Stop the test, check, and build processes you started.

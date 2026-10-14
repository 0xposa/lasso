# Local Coding Agents

Lasso can drive local coding agents — Claude Code, OpenCode, Codex CLI, and
Cursor Agent — with the same session management, progress events, review flow,
verification, and corrective runs as hosted models. Local agents run
headlessly against your project, but **nothing is applied until you review and
approve the diff**.

## How it works

Local agents execute **on your machine, inside the `lasso` CLI process**
(`LocalRuntime`). Prompts, project context, and source code never travel
through Lasso's server — you can point the CLI at any server URL (or none)
and local agents keep working. Hosted models are unchanged: they still run
server-side through the Lasso runtime API and the Model Gateway.

Local agent lifecycle:

1. Before an agent runs, the CLI captures your workspace (a `WorkspaceGuard`
   snapshot of every non-ignored file).
2. The agent's CLI is spawned in your project directory and its structured
   output is normalized into runtime events (progress, tool calls, file
   operations, completion).
3. After the run — success **or** failure — the workspace is rolled back to
   the captured state. The guard's diff becomes the reviewable change set.
4. Approving a change re-applies it; discarding leaves the project untouched.
5. After apply, Lasso runs verification (typecheck/build, when configured).
   Failures are fed back for an automatic corrective run (bounded attempts).

Because the agent writes into the real project directory, the guard's diff is
the single source of truth for what changed — agent-reported file lists are
never trusted on their own.

## Installation

Local agents are detected per-machine by the CLI. Install only the ones you want:

| Agent | Provider id | Install |
| --- | --- | --- |
| Claude Code | `claude_code` | `npm install -g @anthropic-ai/claude-code` |
| OpenCode | `opencode` | `npm install -g opencode-ai` |
| Codex CLI | `codex_cli` | `npm install -g @openai/codex` |
| Cursor Agent | `cursor` | `curl https://cursor.com/install -fsS \| bash` |

The binary names the CLI probes: `claude`, `opencode`, `codex`, `cursor-agent`
(Cursor's CLI is `cursor-agent`, not `cursor`).

## Authentication

Each agent is authenticated with its own login flow. Lasso only *reads*
authentication state via each agent's structured status command:

- **Claude Code** — `claude auth status` (JSON `loggedIn`). Login: run `claude`
  once and complete the flow, or `claude auth login`.
- **OpenCode** — `opencode providers list` (stored credentials marker). Login:
  `opencode auth login` or configure a provider API key.
- **Codex CLI** — `codex login status` (exit code). Login: `codex login`
  (ChatGPT account or API key).
- **Cursor Agent** — `cursor-agent status --format json` (JSON
  `isAuthenticated`). Login: `cursor-agent login`.

An agent that is installed but not authenticated stays visible in the model
menu as **locked**, with the fix instructions shown inline.

Account limits (for example Claude "credit balance is too low" or Codex "usage
limit") are surfaced as authentication-class failures with a clear message —
they are not treated as code errors.

## Model selection

Model option ids are prefixed with the provider (`claude_code:sonnet`,
`opencode:big-pickle`, …). The CLI normalizes them for each agent:

- `claude_code:sonnet` → `sonnet` (also `opus`, `haiku`)
- `opencode:<name>` → `opencode/<name>` (lists real models via `opencode models`
  when available)
- `codex_cli:default` → empty (the agent's own configured default model)
- `cursor:<id>` → passed through (e.g. `sonnet-4`)

An empty `modelId` means "use the agent's default".

## Configuration

Local agents are selected via the backend config attached to a runtime session.
The CLI bridge builds this automatically from the overlay's model menu:

```ts
{
  type: "local_agent",
  provider: "claude_code" | "opencode" | "codex_cli" | "cursor",
  modelId: string,        // normalized id, "" = agent default
  projectPath: string,    // must be the project root
  permissionMode?: string // claude only, default "acceptEdits"
}
```

For programmatic use, `LocalRuntime` (from `@lasso-ai/cli`) implements the
same session surface as `RuntimeClient` — `createSession`, `runSession`,
`getSession`, `verifySession`, `switchModel`, `cancelSession` — but executes
in-process:

```ts
import { getLocalRuntime } from "@lasso-ai/cli/local-runtime";

const runtime = getLocalRuntime();
const session = await runtime.createSession({
  userPrompt: "Add a loading state to the submit button",
  project: { projectId: "app", hasTypeScript: true },
  model: { provider: "claude_code", id: "sonnet" },
  backendConfig: {
    type: "local_agent",
    provider: "claude_code",
    modelId: "sonnet",
    projectPath: "/path/to/project",
  },
});
await runtime.runSession(session.id, "/path/to/project", (event) => {
  console.log(event.type);
});
```

The shared runtime core (`WorkspaceGuard`, `VerificationEngine`,
`LocalSessionRunner`, adapters) is published as `@lasso-ai/cli/runtime` and is
the same code the Lasso server uses for its colocated Mode B deployments.

## Sessions

Local runtime sessions are **in-memory, per CLI process**: they live as long
as the `lasso` bridge process does and are gone when it exits. Review payloads
(`pendingChanges`) are persisted in session metadata and applied from the
review panel regardless. Hosted sessions continue to live server-side (and in
the server's MongoDB when configured).

## Limitations

- **Review-first is mandatory.** There is no "apply silently" mode; every run
  ends in a review (or a no-change completion).
- **Ephemeral local sessions.** Local agent sessions do not survive a CLI
  restart; hosted sessions do.
- **Verification is best-effort.** Typecheck runs only when a `tsconfig.json`
  exists; build only when `package.json` has a `build` script. Missing
  tooling is reported as *skipped* (inconclusive), never as a pass or a
  failure.
- **Session continuation varies.** Claude Code (`--resume`), Codex
  (`exec resume`), and Cursor (`--resume`) can continue their own external
  sessions; OpenCode is re-driven with conversation context each run. Agent
  internal tool-call state is not portable across backends — switching agents
  mid-task transfers conversation/observations/errors only.
- **Cancellation** sends SIGTERM (then SIGKILL after 3s) to the agent process.
  In-flight tool calls are not undone by the agent itself; the workspace guard
  rollback is what keeps the project clean.
- **Permissions.** Claude runs with `--permission-mode acceptEdits`; Codex runs
  with `sandbox_mode="workspace-write"`; agents are instructed not to commit,
  push, or act outside the project directory.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Backend locked: "not installed" | Binary not on your `PATH` | Install the CLI globally; restart the `lasso` CLI so it picks up `PATH` changes |
| Backend locked: "not logged in" | Missing agent credentials | Run the agent's login command listed in the fix instructions |
| "Credit balance is too low" / "usage limit" | Provider account limits | Top up or wait for the limit window; the run is failed cleanly with no partial apply |
| "finished without reporting a successful result" | Agent exited 0 without a terminal success event | Usually a CLI version mismatch — update the agent |
| Changes appear, then vanish before review | Expected: workspace is rolled back until you approve | Approve in the review panel to apply |
| Local agent run works, hosted models don't | Hosted models need the Lasso server API | Check the CLI's server URL / API key; local agents are unaffected |

## API

Local agents do not require any server endpoints — the CLI runs them
directly. The server API remains for hosted models and backend discovery:

- `GET /api/v1/agent-runtime/backends` — probe hosted providers and (for
  colocated deployments) local agents.
- `POST /api/v1/agent-runtime/sessions` — create a hosted-model session (or a
  colocated local-agent session on self-hosted deployments).
- `POST /api/v1/agent-runtime/sessions/:id/run` — run (also used for
  corrective re-runs).
- `POST /api/v1/agent-runtime/sessions/:id/verify` — post-apply verification;
  returns `{ passed, errors, observations, command, requiresFix }`.
- `POST /api/v1/agent-runtime/sessions/:id/model` — switch hosted model or
  local agent mid-session; reports `transferableContext` / `lostContext`.
- `POST /api/v1/agent-runtime/sessions/:id/cancel` — abort the running agent
  and restore the workspace.

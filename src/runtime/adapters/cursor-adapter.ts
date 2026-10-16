/**
 * Cursor Adapter
 *
 * Adapter for the Cursor Agent CLI (binary: `cursor-agent`), a local coding
 * agent with its own agentic loop.
 *
 * Invocation: cursor-agent -p --output-format stream-json --trust [--model m]
 * [--resume <chatId>] <prompt>, cwd set to the project path.
 *
 * Stream-JSON events (system/init, assistant, tool_call, result) are normalized
 * into BackendEvents. Success requires Cursor's terminal result event with
 * is_error=false AND a zero exit code; on failure Cursor exits non-zero, often
 * without a terminal event (stderr carries the error).
 *
 * File changes are not trusted from the agent's report — the orchestrator's
 * WorkspaceGuard diffs the project after the run and restores it before review.
 *
 * Reference: https://cursor.com/docs/cli/reference/output-format
 */

import { promisify } from "node:util";
import { LocalAgentAdapter, LocalAgentConfig, CommandSpec, EventSink } from "./local-agent-adapter";
import { BackendCapabilities, TaskContext } from "../backend-interface";

const execFileAsync = promisify(require("node:child_process").execFile);

interface CursorConfig extends LocalAgentConfig {
  provider: "cursor";
}

interface CursorToolCall {
  args?: Record<string, unknown>;
  result?: {
    success?: Record<string, unknown>;
    error?: { errorMessage?: string } | Record<string, unknown>;
  };
}

interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  call_id?: string;
  tool_call?: Record<string, CursorToolCall>;
}

const TOOL_KIND_MAP: Record<string, string> = {
  readToolCall: "read",
  editToolCall: "edit",
  writeToolCall: "write",
  deleteToolCall: "delete",
  shellToolCall: "shell",
  grepToolCall: "grep",
  globToolCall: "glob",
  lsToolCall: "ls",
  todoToolCall: "todo",
};

const FILE_TOOLS = new Set(["edit", "write", "delete"]);

export class CursorAdapter extends LocalAgentAdapter {
  readonly provider = "cursor" as const;

  constructor(config: CursorConfig) {
    super({ ...config, type: "local_agent", provider: "cursor" });
  }

  getCapabilities(): BackendCapabilities {
    return {
      canStreamEvents: true,
      canIsolateWorkspace: false,
      providesStructuredDiffs: false,
      supportsSessionContinuation: true,
      supportsCancellation: true,
      hasInternalLoop: true,
      supportedFileOperations: "both",
      canRunCommands: true,
      authMethod: "cli_session",
      forbiddenCommands: ["rm -rf /", "mkfs"],
    };
  }

  protected get binary(): string {
    return "cursor-agent";
  }

  protected get installInstructions(): string {
    return "Install the Cursor Agent CLI: curl https://cursor.com/install -fsS | bash, then run 'cursor-agent login'.";
  }

  protected get versionArgs(): string[] {
    return ["-v"];
  }

  protected get supportsResume(): boolean {
    return true;
  }

  protected async checkAuthentication(): Promise<{ authenticated: boolean; error?: string; fixInstructions?: string }> {
    try {
      const { stdout } = (await execFileAsync("cursor-agent", ["status", "--format", "json"], {
        timeout: 10000,
        windowsHide: true,
      })) as { stdout: string };
      const jsonStart = stdout.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(stdout.slice(jsonStart));
          if (parsed && typeof parsed.isAuthenticated === "boolean") {
            return parsed.isAuthenticated
              ? { authenticated: true }
              : {
                  authenticated: false,
                  error: "Cursor Agent is not authenticated.",
                  fixInstructions: "Run 'cursor-agent login' to authenticate with Cursor.",
                };
          }
        } catch {
          // Fall through to exit-code based result.
        }
      }
      return { authenticated: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        authenticated: false,
        error: `Could not verify Cursor Agent authentication: ${message.split("\n")[0]}`,
        fixInstructions: "Run 'cursor-agent login' to authenticate with Cursor.",
      };
    }
  }

  protected buildCommand(context: TaskContext): CommandSpec {
    const resumeId = this.resumeSessionId(context);
    const args = ["-p", "--output-format", context.mode === "conversation" ? "json" : "stream-json", "--trust"];
    if (this.modelId) args.push("--model", this.modelId);
    if (resumeId) args.push("--resume", resumeId);
    args.push(this.buildTaskPrompt(context));

    return { bin: "cursor-agent", args, cwd: (this.config as CursorConfig).projectPath };
  }

  protected handleLine(line: string, context: TaskContext, sink: EventSink): boolean {
    let event: CursorEvent;
    try {
      event = JSON.parse(line) as CursorEvent;
    } catch {
      return false;
    }

    if (event.session_id) sink.state.sessionId = event.session_id;

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          sink.state.sessionId = event.session_id || sink.state.sessionId;
          sink.progress(`Cursor session started${event.model ? ` (model: ${event.model})` : ""}`);
        }
        return true;
      }

      case "assistant": {
        const text = (event.message?.content || [])
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
        if (text) sink.progress(text);
        return true;
      }

      case "tool_call": {
        this.handleToolCall(event, sink);
        return true;
      }

      case "result": {
        if (event.is_error || event.subtype !== "success") {
          sink.state.failureMessage = event.result || `Cursor result subtype: ${event.subtype || "unknown"}`;
          sink.error(sink.state.failureMessage, { recoverable: false });
        } else {
          sink.state.receivedTerminalSuccess = true;
          if (event.result) sink.state.summary = event.result;
        }
        return true;
      }

      default:
        return true;
    }
  }

  private handleToolCall(event: CursorEvent, sink: EventSink): void {
    const toolCall = event.tool_call || {};
    const kindKey = Object.keys(toolCall)[0];
    if (!kindKey) return;
    const toolName = TOOL_KIND_MAP[kindKey] || kindKey;
    const call = toolCall[kindKey] || {};
    const args = call.args || {};

    if (event.subtype === "started") {
      sink.toolStarted(toolName, this.describeArgs(toolName, args));
      return;
    }

    if (event.subtype === "completed") {
      const hasError = Boolean(call.result && call.result.error);
      sink.toolCompleted(toolName, !hasError, this.describeArgs(toolName, args));

      if (hasError && call.result?.error) {
        const err = call.result.error as { errorMessage?: string };
        sink.error(`${toolName} failed: ${err.errorMessage || JSON.stringify(call.result.error).slice(0, 300)}`, { recoverable: true });
      }

      if (FILE_TOOLS.has(toolName) && typeof args.path === "string") {
        const rel = this.relPath(args.path);
        // Guard diff decides create vs modify; only delete is unambiguous here.
        if (toolName === "delete") sink.fileChange("deleted", rel);
        else sink.fileChange("modified", rel);
      }
    }
  }

  private describeArgs(toolName: string, args: Record<string, unknown>): string | undefined {
    if (typeof args.command === "string") return args.command.slice(0, 200);
    if (typeof args.path === "string") return String(args.path);
    if (typeof args.pattern === "string") return String(args.pattern);
    if (typeof args.query === "string") return String(args.query);
    void toolName;
    return undefined;
  }

  protected inspectFailureText(text: string): { message: string; authFailure?: boolean } | null {
    if (!text) return null;
    if (/authentication required|please run ['"]?(cursor-agent |agent )?login|not logged in|unauthorized/i.test(text)) {
      return { message: "Cursor Agent authentication failed.", authFailure: true };
    }
    if (/rate limit|usage limit|quota exceeded/i.test(text)) {
      return { message: "Cursor usage limit or quota exceeded.", authFailure: true };
    }
    return null;
  }
}

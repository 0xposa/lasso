/**
 * Lasso Runtime Client
 * 
 * Client for the new Lasso Agentic Runtime
 * Uses SSE for real-time progress events
 */

export type RuntimeProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "nvidia"
  | "ollama"
  | "claude_code"
  | "opencode"
  | "codex_cli"
  | "cursor";

export interface RuntimeSessionInput {
  userPrompt: string;
  project: {
    projectId: string;
    framework?: string;
    hasTypeScript?: boolean;
    hasReact?: boolean;
    hasNext?: boolean;
    hasVite?: boolean;
    files?: string[];
    currentRoute?: string;
  };
  model: {
    provider: RuntimeProvider;
    id: string;
    name?: string;
  };
  selection?: {
    element?: {
      tag?: string;
      text?: string;
      source?: string;
      attributes?: Record<string, string>;
    };
    viewport?: {
      width: number;
      height: number;
      scrollY?: number;
      scrollHeight?: number;
    };
    route?: string;
    screenshot?: string;
  };
  conversationUid?: string;
  backendConfig?: {
    type: "hosted_model" | "local_agent";
    provider: "claude_code" | "opencode" | "codex_cli" | "cursor";
    modelId?: string;
    projectPath?: string;
  };
}

export interface RuntimeSession {
  id: string;
  phase: "understand" | "inspect" | "plan" | "execute" | "verify" | "recover" | "complete";
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  iteration: number;
  userPrompt: string;
  conversation: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }>;
  observations: Array<{
    id: string;
    type: string;
    summary: string;
    data?: unknown;
    timestamp: number;
    phase?: string;
    actionId?: string;
  }>;
  actions: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
  completedActions: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
  errors: Array<{
    id: string;
    type: string;
    message: string;
    phase: string;
    actionId?: string;
    timestamp: number;
    recoverable: boolean;
  }>;
  plan?: {
    id: string;
    goal: string;
    steps: Array<{
      id: string;
      description: string;
      status: string;
      actionCount?: number;
    }>;
    estimatedActions?: number;
  };
  selection?: RuntimeSessionInput["selection"];
  project: RuntimeSessionInput["project"];
  model: RuntimeSessionInput["model"];
  conversationUid?: string;
  createdAt: Date;
  updatedAt: Date;
  /** Runtime-owned metadata: pendingChanges, backendConfig, backendSessionId, … */
  metadata?: Record<string, unknown>;
}

/** Result of post-apply verification (typecheck/build via VerificationEngine). */
export interface SessionVerificationResult {
  passed: boolean;
  errors: Array<{ id: string; type: string; message: string; phase: string; timestamp: number; recoverable: boolean }>;
  observations: Array<{ id: string; type: string; summary: string; timestamp: number }>;
  command?: string;
  requiresFix: boolean;
}

/**
 * The session surface shared by RuntimeClient (hosted, via Lasso server) and
 * LocalRuntime (local coding agents, executed in this process).
 */
export interface RuntimeFacade {
  createSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  runSession(sessionId: string, projectPath: string, onEvent: RuntimeEventHandler, signal?: AbortSignal): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSession>;
  verifySession(sessionId: string, projectPath: string): Promise<SessionVerificationResult>;
  switchModel(
    sessionId: string,
    model: { provider: string; id: string; name?: string },
    apiKey?: string,
    backendConfig?: RuntimeSessionInput["backendConfig"]
  ): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
}

export type RuntimeEvent =
  | { type: "agent_started"; sessionId: string; data: {}; timestamp: number }
  | { type: "agent_reasoning"; sessionId: string; data: { summary: string }; timestamp: number }
  | { type: "phase_changed"; sessionId: string; data: { from: string; to: string }; timestamp: number }
  | { type: "tool_started"; sessionId: string; data: { actionType: string }; timestamp: number }
  | { type: "tool_completed"; sessionId: string; data: { actionType: string; success: boolean }; timestamp: number }
  | { type: "observation"; sessionId: string; data: { observationType: string; summary: string }; timestamp: number }
  | { type: "verification_started"; sessionId: string; data: { verificationType: string }; timestamp: number }
  | { type: "verification_completed"; sessionId: string; data: { verificationType: string; success: boolean }; timestamp: number }
  | { type: "waiting_for_user"; sessionId: string; data: { question: string }; timestamp: number }
  | { type: "error"; sessionId: string; data: Record<string, unknown>; timestamp: number }
  | { type: "model_changed"; sessionId: string; data: { from: any; to: any }; timestamp: number }
  | { type: "agent_completed"; sessionId: string; data: Record<string, unknown>; timestamp: number }
  | { type: "agent_cancelled"; sessionId: string; data: Record<string, unknown>; timestamp: number }
  | { type: "agent_failed"; sessionId: string; data: Record<string, unknown>; timestamp: number }
  | { type: "file_changed"; sessionId: string; data: Record<string, unknown>; timestamp: number }
  | { type: "started"; sessionId: string }
  | { type: "completed"; sessionId: string };

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

export class RuntimeClient {
  private serverUrl: string;
  private apiKey?: string;

  constructor(serverUrl: string, apiKey?: string) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
  }

  /**
   * Create a new runtime session
   */
  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    const data = await response.json();
    return data as RuntimeSession;
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<RuntimeSession> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}`, {
      headers: {
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.statusText}`);
    }

    const data = await response.json();
    return data as RuntimeSession;
  }

  /**
   * Run a session with SSE event streaming
   */
  async runSession(
    sessionId: string,
    projectPath: string,
    onEvent: RuntimeEventHandler,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({ projectPath }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to run session: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.trim() || !line.startsWith("data: ")) continue;

          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data) as RuntimeEvent;
            await onEvent(event);
          } catch (error) {
            console.error("Failed to parse SSE event:", error);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Cancel a running session
   */
  async cancelSession(sessionId: string): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: {
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel session: ${response.statusText}`);
    }
  }

  /**
   * Switch model/backend for a session
   */
  async switchModel(
    sessionId: string,
    model: { provider: string; id: string; name?: string },
    apiKey?: string,
    backendConfig?: RuntimeSessionInput["backendConfig"]
  ): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}/model`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({ ...model, apiKey, backendConfig }),
    });

    if (!response.ok) {
      throw new Error(`Failed to switch model: ${response.statusText}`);
    }
  }

  /**
   * Verify the workspace for a session (after reviewed changes were applied).
   *
   * Returns whether verification passed; on failure the session keeps the
   * verification errors so a corrective re-run can fix them.
   */
  async verifySession(
    sessionId: string,
    projectPath: string
  ): Promise<SessionVerificationResult> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({ projectPath }),
    });

    if (!response.ok) {
      throw new Error(`Failed to verify session: ${response.statusText}`);
    }

    return (await response.json()) as SessionVerificationResult;
  }

  /**
   * List available backends from the server (hosted providers + local agents).
   */
  async listBackends(projectPath?: string): Promise<{
    backends: Array<{
      provider: string;
      type: string;
      available: boolean;
      authenticated: boolean;
      installed?: boolean;
      version?: string;
      error?: string;
      fixInstructions?: string;
      models?: Array<{ id: string; label: string }>;
    }>;
  }> {
    const url = `${this.serverUrl}/api/v1/agent-runtime/backends${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`;
    const response = await fetch(url, {
      headers: {
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list backends: ${response.statusText}`);
    }

    return (await response.json()) as { backends: any[] };
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/v1/agent-runtime/sessions/${sessionId}`, {
      method: "DELETE",
      headers: {
        ...(this.apiKey && { "Authorization": `Bearer ${this.apiKey}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to delete session: ${response.statusText}`);
    }
  }
}

/**
 * BackendEvent → AgentEvent (wire format) mapping.
 *
 * Shared by the server orchestrator (SSE) and the CLI LocalRuntime so both
 * execution paths speak the identical event vocabulary.
 */

import { BackendEvent } from "./backend-interface";
import { AgentEvent, AgentEventType } from "./agent-runtime";

const BACKEND_TO_AGENT_TYPE: Record<string, AgentEventType> = {
  task_started: "agent_started",
  task_progress: "agent_reasoning",
  tool_started: "tool_started",
  tool_completed: "tool_completed",
  file_read: "observation",
  file_modified: "file_changed",
  file_created: "file_changed",
  file_deleted: "file_changed",
  diff_available: "file_changed",
  verification_started: "verification_started",
  verification_completed: "verification_completed",
  error: "error",
  waiting_for_user: "waiting_for_user",
  task_completed: "agent_completed",
  task_cancelled: "agent_cancelled",
  task_failed: "agent_failed",
};

export function mapBackendEventType(backendType: string): AgentEventType {
  return BACKEND_TO_AGENT_TYPE[backendType] || "observation";
}

/** Convert one backend event into the runtime wire event. */
export function toAgentEvent(sessionId: string, event: BackendEvent): AgentEvent {
  return {
    type: mapBackendEventType(event.type),
    sessionId,
    timestamp: event.timestamp,
    data: event.data,
  };
}

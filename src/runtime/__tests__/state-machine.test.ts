import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentStateMachine } from "../agent-state-machine";
import { LassoAgentSession } from "../agent-runtime";

function makeSession(overrides: Partial<LassoAgentSession> = {}): LassoAgentSession {
  return {
    id: "sess-1",
    phase: "verify",
    status: "running",
    iteration: 1,
    userPrompt: "Add a greeting",
    conversation: [],
    observations: [],
    actions: [],
    completedActions: [],
    errors: [],
    project: {
      projectId: "proj-1",
      hasTypeScript: true,
      hasTailwind: false,
      hasReact: false,
      hasNext: false,
      hasVite: true,
      files: [],
    },
    model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const action = {
  id: "act-1",
  type: "edit_file" as const,
  data: { filePath: "a.ts", oldString: "a", newString: "b" },
};

describe("AgentStateMachine (review / corrective flow)", () => {
  it("cannot enter recover without verification errors", () => {
    const session = makeSession();
    const result = AgentStateMachine.transition(session, "recover");

    assert.equal(result.success, false);
    assert.match(result.error || "", /without errors/i);
  });

  it("can enter recover once verification errors exist", () => {
    const session = makeSession({
      errors: [
        {
          id: "err-1",
          type: "verification",
          message: "Build failed",
          phase: "verify",
          timestamp: Date.now(),
          recoverable: true,
        },
      ],
    });

    const result = AgentStateMachine.transition(session, "recover");
    assert.equal(result.success, true);
  });

  it("complete is terminal", () => {
    const session = makeSession({ phase: "complete", actions: [action], completedActions: [action] });

    assert.equal(AgentStateMachine.canTransition(session, "execute"), false);
    assert.equal(AgentStateMachine.canTransition(session, "verify"), false);
    assert.equal(AgentStateMachine.canTransition(session, "recover"), false);
  });

  it("cannot complete a session with no executed actions", () => {
    const session = makeSession({ actions: [], completedActions: [] });
    const result = AgentStateMachine.transition(session, "complete");

    assert.equal(result.success, false);
    assert.match(result.error || "", /without executing/i);
  });

  it("cannot complete a failed session", () => {
    const session = makeSession({ status: "failed", actions: [action], completedActions: [action] });
    const result = AgentStateMachine.transition(session, "complete");

    assert.equal(result.success, false);
    assert.match(result.error || "", /failed session/i);
  });

  it("backend switching allowed only while running and not complete", () => {
    assert.equal(AgentStateMachine.canSwitchModel(makeSession({ status: "running", phase: "execute" })), true);
    assert.equal(AgentStateMachine.canSwitchModel(makeSession({ status: "running", phase: "complete" })), false);
    assert.equal(AgentStateMachine.canSwitchModel(makeSession({ status: "waiting", phase: "execute" })), false);
    assert.equal(AgentStateMachine.canSwitchModel(makeSession({ status: "cancelled", phase: "execute" })), false);
  });

  it("next phase after a failed verification is recover, after success is complete", () => {
    const failed = makeSession({
      phase: "verify",
      completedActions: [action],
      errors: [
        {
          id: "err-1",
          type: "verification",
          message: "Build failed",
          phase: "verify",
          timestamp: Date.now(),
          recoverable: true,
        },
      ],
    });
    assert.equal(AgentStateMachine.determineNextPhase(failed, { type: "decide", goal: "verify" }), "recover");

    const passed = makeSession({ phase: "verify", completedActions: [action], actions: [action] });
    assert.equal(AgentStateMachine.determineNextPhase(passed, { type: "decide", goal: "verify" }), "complete");
  });
});

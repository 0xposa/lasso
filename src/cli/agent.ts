import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export type SourceChange = {
  filePath: string;
  oldString: string;
  newString: string;
  operation?: "created" | "modified" | "deleted";
};

export type AgentConfig = {
  provider: "anthropic" | "openai" | "google" | "ollama" | "nvidia";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  lassoKey?: string;
  serverUrl?: string;
};

export type AgentProgress = (status: "thinking" | "working" | "review" | "error" | "stopped", message: string, detail?: string) => void;
export type AgentPromptHandler = (prompt: { question: string; options?: string[] }) => void;

// Prompt handlers for runtime agent prompts
const agentPromptHandlers = new Map<string, (value: string) => void>();

export function respondToAgentPrompt(taskId: string, value: string): boolean {
  const handler = agentPromptHandlers.get(taskId);
  if (handler) {
    handler(value);
    agentPromptHandlers.delete(taskId);
    return true;
  }
  return false;
}

export function waitForAgentPrompt(taskId: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      agentPromptHandlers.delete(taskId);
      reject(new Error("Agent prompt timeout"));
    }, timeoutMs);

    agentPromptHandlers.set(taskId, (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

export async function installPackages(
  cwd: string,
  packages: string[],
  onProgress?: AgentProgress
): Promise<string[]> {
  const validPkgs = [...new Set(
    packages
      .map((p) => p.trim().replace(/^['"`]|['"`]$/g, ""))
      .filter((p) => /^(@[a-z0-9\-~][a-z0-9\-_.]*\/)?[a-z0-9\-~][a-z0-9\-_.]*$/i.test(p))
  )];

  if (validPkgs.length === 0) return [];

  if (onProgress) onProgress("working", `Installing ${validPkgs.length} package(s)...`);

  const pkgPath = path.join(cwd, "package.json");
  let pkgManager = "npm";
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) pkgManager = "pnpm";
  else if (fs.existsSync(path.join(cwd, "yarn.lock"))) pkgManager = "yarn";

  const installCmd = pkgManager === "pnpm" ? "add" : pkgManager === "yarn" ? "add" : "install";
  const args = [installCmd, ...validPkgs, "--silent"];

  try {
    await execFileAsync(pkgManager, args, { cwd, maxBuffer: 1024 * 1024 });
    return validPkgs;
  } catch (error) {
    if (onProgress) onProgress("error", `Failed to install packages: ${error instanceof Error ? error.message : "Unknown error"}`);
    throw error;
  }
}

export async function executeWebSearch(
  query: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<string> {
  if (!apiKey) {
    throw new Error("API key required for web search");
  }

  const response = await fetch("https://api.jina.ai/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ q: query, limit: 5 }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Web search failed: ${response.statusText}`);
  }

  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return data.results?.map(r => `[${r.title}](${r.url})\n${r.content}`).join("\n\n") || "No results found";
}

export async function executeAgentCommand(
  cwd: string,
  command: string,
  signal?: AbortSignal,
  onProgress?: AgentProgress
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (onProgress) onProgress("working", `Running: ${command}`);

  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(/\s+/);
    const proc = spawn(cmd, args, { cwd, signal });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });

    proc.on("error", (error) => {
      reject(error);
    });
  });
}

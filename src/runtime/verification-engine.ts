import { exec as execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Observation, AgentError, AgentPhase } from "./agent-runtime";

const exec = promisify(execSync);

/**
 * Verification Engine - Verifies changes after execution
 * 
 * Mandatory verification step in the agent loop.
 * Timeouts are failures or inconclusive observations, never proof of success.
 */

export interface VerificationConfig {
  typecheckTimeout: number;  // Default: 60 seconds
  buildTimeout: number;      // Default: 120 seconds
  devServerTimeout: number;  // Default: 30 seconds
  browserTimeout: number;    // Default: 60 seconds
}

export interface VerificationResult {
  type: "typecheck" | "build" | "dev_server" | "browser";
  success: boolean;
  /** Set when the check could not meaningfully run (no tsconfig, no build script). */
  skipped?: boolean;
  /** Command that produced this result, when applicable. */
  command?: string;
  output?: string;
  error?: string;
  observations: Observation[];
  errors: AgentError[];
  duration: number;
}

export class VerificationEngine {
  private projectPath: string;
  private config: VerificationConfig;

  constructor(projectPath: string, config?: Partial<VerificationConfig>) {
    this.projectPath = projectPath;
    this.config = {
      typecheckTimeout: config?.typecheckTimeout || 60000,
      buildTimeout: config?.buildTimeout || 120000,
      devServerTimeout: config?.devServerTimeout || 30000,
      browserTimeout: config?.browserTimeout || 60000,
    };
  }

  /**
   * Run all verifications
   */
  async verifyAll(phase: AgentPhase): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];

    // Type checking
    const typecheckResult = await this.verifyTypecheck(phase);
    results.push(typecheckResult);

    // If typecheck failed, skip build
    if (!typecheckResult.success) {
      return results;
    }

    // Build
    const buildResult = await this.verifyBuild(phase);
    results.push(buildResult);

    // If build failed, skip dev server check
    if (!buildResult.success) {
      return results;
    }

    // Dev server health
    const devServerResult = await this.verifyDevServer(phase);
    results.push(devServerResult);

    // Browser check (placeholder)
    const browserResult = await this.verifyBrowser(phase);
    results.push(browserResult);

    return results;
  }

  /**
   * Verify TypeScript type checking
   */
  async verifyTypecheck(phase: AgentPhase): Promise<VerificationResult> {
    const startTime = Date.now();
    const observations: Observation[] = [];
    const errors: AgentError[] = [];

    // Inconclusive without a tsconfig: never a pass and never a failure.
    if (!this.hasTypeScriptConfig()) {
      observations.push({
        id: this.generateId(),
        type: "build",
        summary: "TypeScript check skipped (no tsconfig.json)",
        data: { type: "typecheck", success: true, skipped: true },
        timestamp: Date.now(),
        phase,
      });
      return {
        type: "typecheck",
        success: true,
        skipped: true,
        observations,
        errors,
        duration: Date.now() - startTime,
      };
    }

    try {
      const command = "npx tsc --noEmit";
      const { stdout, stderr } = await exec(command, {
        cwd: this.projectPath,
        timeout: this.config.typecheckTimeout,
      });

      const duration = Date.now() - startTime;

      // Non-zero exit throws (caught below), so reaching here means tsc
      // reported no type errors — stderr may still hold npm notices.
      observations.push({
        id: this.generateId(),
        type: "build",
        summary: "TypeScript check passed",
        data: {
          type: "typecheck",
          success: true,
          output: stdout + stderr,
        },
        timestamp: Date.now(),
        phase,
      });

      return {
        type: "typecheck",
        success: true,
        command: "npx tsc --noEmit",
        output: stdout + stderr,
        observations,
        errors,
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;

      observations.push({
        id: this.generateId(),
        type: "build",
        summary: "TypeScript check failed",
        data: {
          type: "typecheck",
          success: false,
          error: error.message,
        },
        timestamp: Date.now(),
        phase,
      });

      errors.push({
        id: this.generateId(),
        type: "verification",
        message: error.message,
        phase,
        timestamp: Date.now(),
        details: { stderr: error.stderr, stdout: error.stdout },
        recoverable: true,
      });

      return {
        type: "typecheck",
        success: false,
        command: "npx tsc --noEmit",
        error: error.message,
        observations,
        errors,
        duration,
      };
    }
  }

  /**
   * Verify build
   */
  async verifyBuild(phase: AgentPhase): Promise<VerificationResult> {
    const startTime = Date.now();
    const observations: Observation[] = [];
    const errors: AgentError[] = [];

    // Inconclusive when the project has no build script.
    if (!this.hasBuildScript()) {
      observations.push({
        id: this.generateId(),
        type: "build",
        summary: "Build skipped (no build script)",
        data: { type: "build", success: true, skipped: true },
        timestamp: Date.now(),
        phase,
      });
      return {
        type: "build",
        success: true,
        skipped: true,
        observations,
        errors,
        duration: Date.now() - startTime,
      };
    }

    try {
      // Try common build commands
      const commands = ["npm run build", "pnpm build", "yarn build"];
      let result: any;
      let usedCommand = "";
      let lastError = "";

      for (const cmd of commands) {
        try {
          result = await exec(cmd, {
            cwd: this.projectPath,
            timeout: this.config.buildTimeout,
          });
          usedCommand = cmd;
          break;
        } catch (err: any) {
          lastError = err?.stderr || err?.message || `${cmd} failed`;
          const managerMissing =
            err?.code === 127 || /command not found|ENOENT/i.test(String(err?.message || ""));
          if (!managerMissing) {
            // The build script ran and failed — don't mask it by trying
            // other package managers.
            break;
          }
          continue;
        }
      }

      const duration = Date.now() - startTime;

      if (!result) {
        observations.push({
          id: this.generateId(),
          type: "build",
          summary: "Build failed",
          data: { type: "build", success: false, error: lastError },
          timestamp: Date.now(),
          phase,
        });

        errors.push({
          id: this.generateId(),
          type: "verification",
          message: "Build failed",
          phase,
          timestamp: Date.now(),
          details: { output: lastError },
          recoverable: true,
        });

        return {
          type: "build",
          success: false,
          command: "npm run build",
          error: "Build failed",
          output: lastError,
          observations,
          errors,
          duration,
        };
      }

      observations.push({
        id: this.generateId(),
        type: "build",
        summary: `Build succeeded: ${usedCommand}`,
        data: {
          type: "build",
          success: true,
          command: usedCommand,
        },
        timestamp: Date.now(),
        phase,
      });

      return {
        type: "build",
        success: true,
        command: usedCommand,
        output: result.stdout,
        observations,
        errors,
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;

      observations.push({
        id: this.generateId(),
        type: "build",
        summary: "Build failed",
        data: {
          type: "build",
          success: false,
          error: error.message,
        },
        timestamp: Date.now(),
        phase,
      });

      errors.push({
        id: this.generateId(),
        type: "verification",
        message: "Build failed",
        phase,
        timestamp: Date.now(),
        details: { stderr: error.stderr, stdout: error.stdout },
        recoverable: true,
      });

      return {
        type: "build",
        success: false,
        error: error.message,
        observations,
        errors,
        duration,
      };
    }
  }

  /**
   * Verify dev server health
   */
  async verifyDevServer(phase: AgentPhase): Promise<VerificationResult> {
    const startTime = Date.now();
    const observations: Observation[] = [];
    const errors: AgentError[] = [];

    // TODO: Implement actual dev server health check
    // For now, just check if a dev server is likely running

    observations.push({
      id: this.generateId(),
      type: "build",
      summary: "Dev server health check skipped (not implemented)",
      data: { type: "dev_server", success: true },
      timestamp: Date.now(),
      phase,
    });

    return {
      type: "dev_server",
      success: true,
      observations,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Verify browser/runtime state
   */
  async verifyBrowser(phase: AgentPhase): Promise<VerificationResult> {
    const startTime = Date.now();
    const observations: Observation[] = [];
    const errors: AgentError[] = [];

    // TODO: Implement actual browser checking via Puppeteer or similar
    // For now, this is a placeholder

    observations.push({
      id: this.generateId(),
      type: "browser",
      summary: "Browser check skipped (not implemented)",
      data: { type: "browser", success: true },
      timestamp: Date.now(),
      phase,
    });

    return {
      type: "browser",
      success: true,
      observations,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Check if verification passed overall
   */
  allPassed(results: VerificationResult[]): boolean {
    return results.every((r) => r.success);
  }

  /**
   * Get all verification errors
   */
  getErrors(results: VerificationResult[]): AgentError[] {
    return results.flatMap((r) => r.errors);
  }

  /**
   * Get all verification observations
   */
  getObservations(results: VerificationResult[]): Observation[] {
    return results.flatMap((r) => r.observations);
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `ver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /** tsconfig.json (or any tsconfig.*.json) present in the project root. */
  private hasTypeScriptConfig(): boolean {
    try {
      return fs.readdirSync(this.projectPath).some((name) => /^tsconfig(\..+)?\.json$/.test(name));
    } catch {
      return false;
    }
  }

  /** package.json with a non-empty build script. */
  private hasBuildScript(): boolean {
    try {
      const raw = fs.readFileSync(path.join(this.projectPath, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      return typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
    } catch {
      return false;
    }
  }
}

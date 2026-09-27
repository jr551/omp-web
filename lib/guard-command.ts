import { spawn } from "child_process";

/**
 * Guard command evaluation: run an arbitrary bash command with a hard timeout
 * and decide whether it "passes" (exit 0, optionally matching a stdout regex).
 *
 * Factored out of the routine scheduler so other features (e.g. a future
 * "smartwake" tool that polls a condition) can reuse the exact same semantics.
 * The command string is the user's own config; it is always run as
 * `bash -lc "<command>"` and never string-interpolated with untrusted data.
 */

export interface GuardCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GuardVerdict {
  passed: boolean;
  reason?: string;
}

export interface EvaluateGuardOptions {
  timeoutMs: number;
  expectOutputMatches?: string;
  signal?: AbortSignal;
  /** Injectable command runner (tests pass a fake; no real shell). */
  runner?: GuardCommandRunner;
}

export type GuardCommandRunner = (command: string, timeoutMs: number, signal: AbortSignal) => Promise<GuardCommandResult>;

/** Run a guard command via `bash -lc`, capturing stdout/exit code with a hard timeout. */
export const runGuardCommand: GuardCommandRunner = (command, timeoutMs, signal) =>
  new Promise<GuardCommandResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: GuardCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut }));
    child.on("close", (code) => finish({ exitCode: timedOut ? null : code, stdout, stderr, timedOut }));
  });

/** Whether a guard command result should allow the gated job to run. */
export function guardPasses(result: GuardCommandResult, expectOutputMatches?: string): GuardVerdict {
  if (result.timedOut) return { passed: false, reason: "condition check timed out" };
  if (result.exitCode !== 0) return { passed: false, reason: `condition not met (exit ${result.exitCode ?? "null"})` };
  if (expectOutputMatches) {
    let regex: RegExp;
    try {
      regex = new RegExp(expectOutputMatches);
    } catch {
      return { passed: false, reason: "invalid expected-output pattern" };
    }
    if (!regex.test(result.stdout)) return { passed: false, reason: "condition not met (output mismatch)" };
  }
  return { passed: true };
}

/**
 * Run a guard command and return its verdict in one call. The command runner is
 * injectable so tests never touch a real shell.
 */
export async function evaluateGuard(command: string, options: EvaluateGuardOptions): Promise<GuardVerdict> {
  const runner = options.runner ?? runGuardCommand;
  const signal = options.signal ?? new AbortController().signal;
  try {
    const result = await runner(command, options.timeoutMs, signal);
    return guardPasses(result, options.expectOutputMatches);
  } catch (error) {
    return { passed: false, reason: `condition check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

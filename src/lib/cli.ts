import { spawn } from 'node:child_process';

/**
 * Thin wrapper around `monoceros …` — the ONLY way this tool talks to
 * the workbench. Imports from the workbench package are deliberately
 * out of scope (see CLAUDE.md → „Was bewusst nicht als Dependency
 * drin ist").
 *
 * Two modes:
 *
 *   - `run()` — streaming, the child's stdout/stderr flow through
 *     to the user's terminal. For long-running steps (`apply`, `run`)
 *     where the builder wants to see progress.
 *   - `capture()` — buffered, returns the combined output. For short
 *     queries (`--version`, `status`) where we want to inspect the
 *     reply.
 */

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  /** Override the binary name (default: `monoceros`). */
  bin?: string;
  /** Override the env passed to the child. */
  env?: NodeJS.ProcessEnv;
  /** Don't reject on non-zero exit — return the result and let the caller decide. */
  allowNonZero?: boolean;
}

/** Run `monoceros …` with streaming stdio. Returns the exit code. */
export async function run(
  args: string[],
  opts: CliOptions = {},
): Promise<number> {
  const bin = opts.bin ?? 'monoceros';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      env: opts.env ?? process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(
          new Error(`\`${bin} ${args.join(' ')}\` exited with ${exitCode}`),
        );
        return;
      }
      resolve(exitCode);
    });
  });
}

/**
 * Run `monoceros …` and buffer the output. Useful for short queries
 * (`--version`, `status`) where the caller wants the text back.
 *
 * Throws on non-zero exit unless `allowNonZero: true`.
 */
export async function capture(
  args: string[],
  opts: CliOptions = {},
): Promise<CliResult> {
  const bin = opts.bin ?? 'monoceros';
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code ?? 0;
      const result: CliResult = { exitCode, stdout, stderr };
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(
          new Error(
            `\`${bin} ${args.join(' ')}\` exited with ${exitCode}\n${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Probe whether `monoceros` is on PATH. Returns the version string
 * (with leading `v` stripped) when found, `null` otherwise — the
 * caller surfaces a clear "install monoceros first" hint instead of
 * letting the spawn fail with ENOENT mid-scenario.
 */
export async function detectMonoceros(): Promise<string | null> {
  try {
    const result = await capture(['--version'], { allowNonZero: true });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim().replace(/^v/, '');
  } catch {
    return null;
  }
}

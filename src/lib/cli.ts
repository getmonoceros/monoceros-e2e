import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

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

export interface ResolvedInvocation {
  /** Process to spawn. */
  command: string;
  /** Args to prepend before the caller's args. */
  prependArgs: readonly string[];
}

/**
 * Walk PATH × PATHEXT for `<name><ext>` and return the first hit, or
 * null if the binary isn't on PATH.
 */
function findOnPath(name: string): string | null {
  const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(
    path.delimiter,
  );
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of pathExts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not there, try next */
      }
    }
  }
  return null;
}

/**
 * Resolve how to invoke `monoceros` on the current platform.
 *
 * On macOS / Linux: spawn `name` directly, no transform.
 *
 * On Windows: this is the rabbit hole. npm installs `monoceros.cmd`
 * (cmd.exe shim) plus a `.ps1` and a bash shim — no bare
 * `monoceros.exe`. Two paths both have problems:
 *
 *   - Spawn the .cmd directly: Node 20+ throws EINVAL synchronously
 *     for batch files (post CVE-2024-27980 lockdown).
 *   - Spawn with `shell: true`: works around the EINVAL but now
 *     cmd.exe is in the call chain and interprets our args. Our
 *     scenarios pass bash scripts like `</dev/tcp/postgres/5432`,
 *     where `<` is a cmd.exe redirect operator -- the script never
 *     reaches the container.
 *
 * Bypass cmd.exe entirely: parse the .cmd shim, extract the JS entry
 * point it would have invoked, and spawn the current node binary on
 * that entry directly. Node ↔ node, no shell, no quoting hell.
 *
 * The npm-generated shim references the JS entry as either
 *   "%~dp0\…\bin.js"   (older npm)
 * or
 *   "%dp0%\…\bin.js"   (npm v10+, uses CALL :find_dp0 indirection
 *                        so paths with parentheses don't break)
 * One regex handles both.
 */
export function resolveInvocation(name: string): ResolvedInvocation {
  if (process.platform !== 'win32') return { command: name, prependArgs: [] };
  if (path.extname(name)) return { command: name, prependArgs: [] };

  const cmdPath = findOnPath(name);
  if (!cmdPath) return { command: name, prependArgs: [] };

  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return { command: cmdPath, prependArgs: [] };
  }
  const match = content.match(/"%~?dp0%?[\\/]([^"]+?\.js)"/i);
  const captured = match?.[1];
  if (!captured) return { command: cmdPath, prependArgs: [] };

  const binJs = path.join(path.dirname(cmdPath), captured);
  if (!existsSync(binJs)) return { command: cmdPath, prependArgs: [] };

  return { command: process.execPath, prependArgs: [binJs] };
}

/** Run `monoceros …` with streaming stdio. Returns the exit code. */
export async function run(
  args: string[],
  opts: CliOptions = {},
): Promise<number> {
  const bin = opts.bin ?? 'monoceros';
  const { command, prependArgs } = resolveInvocation(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prependArgs, ...args], {
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
  const { command, prependArgs } = resolveInvocation(bin);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...prependArgs, ...args], {
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

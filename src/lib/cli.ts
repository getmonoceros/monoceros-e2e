import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
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

/**
 * Resolve a bare command name (`monoceros`) to the absolute path of
 * the runnable shim on Windows. npm installs `monoceros.cmd` (cmd.exe
 * shim) alongside `.ps1` and a bash shim, but Node's spawn on Windows
 * does NOT walk PATHEXT to auto-discover the .cmd. We do it ourselves.
 *
 * Why not `shell: true`. That's the obvious alternative — let cmd.exe
 * resolve via PATHEXT — but cmd.exe also interprets the args. Our
 * scenarios pass bash scripts (e.g. the postgres probe contains
 * `</dev/tcp/...`) where the `<` is a cmd.exe redirect operator and
 * gets eaten before bash ever sees it. Spawning the resolved `.cmd`
 * path directly avoids cmd.exe's arg interpretation: Node 20+'s safe
 * `.cmd` handling (post CVE-2024-27980) wraps the args in quotes
 * before handing to cmd.exe, neutralizing the special chars.
 *
 * No-op everywhere else: returns `name` unchanged on macOS / Linux,
 * and returns it unchanged if it already carries an extension.
 */
function resolveBinPath(name: string): string {
  if (process.platform !== 'win32') return name;
  if (path.extname(name)) return name;
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
  return name; // fallback — spawn will ENOENT, but with a clear name
}

/** Run `monoceros …` with streaming stdio. Returns the exit code. */
export async function run(
  args: string[],
  opts: CliOptions = {},
): Promise<number> {
  const bin = opts.bin ?? 'monoceros';
  const resolvedBin = resolveBinPath(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedBin, args, {
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
  const resolvedBin = resolveBinPath(bin);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(resolvedBin, args, {
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

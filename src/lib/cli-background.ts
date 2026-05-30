import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Host-side helper to run a long-lived `monoceros …` command in the
 * background and surface a handle the scenario can kill cleanly.
 *
 * Used by scenarios where the workbench CLI itself runs as a
 * foreground process for the duration of a probe — `monoceros
 * tunnel <name> <service>` being the canonical case (see ADR 0009).
 * The scenario starts the tunnel, waits a moment for it to be
 * ready, runs the probe, then signals the background process to
 * exit.
 *
 * Output is buffered (not streamed) — long-lived CLI output would
 * otherwise interleave with the scenario's own step markers.
 * Captured stdout/stderr stay accessible via the handle for
 * post-mortem if anything goes sideways.
 */

export interface BackgroundCliOptions {
  bin?: string;
  /** Wait this many ms after spawn before resolving start(). */
  warmupMs?: number;
}

export interface BackgroundCliHandle {
  /** Resolves with the exit code once the process has exited. */
  exited: Promise<number>;
  /** Sends a signal to the child. Idempotent. */
  signal: (sig: NodeJS.Signals) => void;
  /** Captured stdout up to this point. */
  readStdout: () => string;
  /** Captured stderr up to this point. */
  readStderr: () => string;
}

/**
 * Spawn `monoceros …` in the background and return a handle. The
 * returned promise resolves AFTER the `warmupMs` grace period (default
 * 1500ms) so callers can use a single `await` to mean "started and
 * had a moment to come up". If the process exits before warmup
 * finishes, the promise rejects with the captured stderr.
 *
 * Spawned `detached: true` so the child gets its own process group.
 * Signals via `signal()` go to the WHOLE group (`process.kill(-pgid,
 * sig)`) — that's what mimics terminal Ctrl+C, which is what
 * `monoceros tunnel` (and similar foreground-CLI patterns) expects.
 * Sending the signal to the parent PID alone would be swallowed by
 * the parent's signal handler and never reach the docker-run child.
 */
export async function startBackground(
  args: string[],
  opts: BackgroundCliOptions = {},
): Promise<BackgroundCliHandle> {
  const bin = opts.bin ?? 'monoceros';
  const warmupMs = opts.warmupMs ?? 1500;

  const child: ChildProcess = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let exited: number | null = null;
  const exitedPromise = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') {
        exited = code;
        resolve(code);
      } else if (signal) {
        // Map signal-exits to the conventional 128 + n value.
        const n = signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1;
        exited = 128 + n;
        resolve(exited);
      } else {
        exited = 0;
        resolve(0);
      }
    });
  });

  // Race the warmup against early-exit so a misconfigured command
  // surfaces fast instead of dragging the scenario through a stale
  // probe. The timer is left referenced — we want the event loop
  // to wait the full warmup period, not flake out if there's a
  // momentarily-empty loop.
  await new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      if (exited !== null) {
        reject(
          new Error(
            `\`${bin} ${args.join(' ')}\` exited during warmup with ${exited}\n${stderr.trim()}`,
          ),
        );
      } else {
        resolve();
      }
    }, warmupMs);
  });

  return {
    exited: exitedPromise,
    signal: (sig: NodeJS.Signals) => {
      if (exited !== null) return;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Negative PID = signal the whole process group.
        // detached spawn put the child at the head of its own group,
        // so this reaches both `monoceros tunnel` and its docker-run
        // grandchild, mirroring terminal Ctrl+C semantics.
        process.kill(-pid, sig);
      } catch {
        // The group might be partially gone (child exited but
        // grandchildren still alive, or vice versa). Fall back to a
        // direct kill on the parent — if anything is still alive, this
        // catches it.
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

import { createConnection } from 'node:net';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import {
  startBackground,
  type BackgroundCliHandle,
} from '../lib/cli-background.js';

/**
 * `with-tunnel` — `monoceros tunnel <name> postgres` foreground +
 * TCP-probe from the host.
 *
 * Proves the tunnel strecke shipped in 1.10.0 (ADR 0009): a
 * short-lived `alpine/socat` sidecar forwarding `127.0.0.1:5432` →
 * `<compose-service>:5432`, signalled via SIGINT for clean teardown.
 *
 * Host-side probe is a plain Node `net.createConnection` — proves
 * the socket accepts a connection without needing `psql` or other
 * host-OS dependencies. Going deeper than TCP-connect here would
 * require a postgres client on the host, which contradicts the
 * cross-OS portability goal of the e2e tool.
 */
export const withTunnel: Scenario = {
  id: 'with-tunnel',
  description:
    'init → apply → monoceros tunnel (background) → TCP-probe 127.0.0.1:5432 from host → teardown',
  estimatedSeconds: 120,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-languages=node --with-services=postgres`, () =>
      ctx.cli(['init', ctx.name, '--with-languages=node', '--with-services=postgres']),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    // Wait for postgres to be ready before the tunnel runs — same
    // baseline check used in `with-services`. If postgres is still
    // initialising when the tunnel hits, socat would connect to the
    // service but the postgres process wouldn't yet accept TCP, and
    // the probe a step later would race.
    await ctx.step(`postgres:5432 reachable from workspace`, () =>
      probePostgresFromWorkspace(ctx),
    );

    const tunnel = await ctx.step(
      `start \`monoceros tunnel ${ctx.name} postgres --local-port=15432\``,
      (): Promise<BackgroundCliHandle> =>
        startBackground(
          ['tunnel', ctx.name, 'postgres', '--local-port=15432'],
          { warmupMs: 2000 },
        ),
    );

    try {
      await ctx.step(
        `host can TCP-connect to 127.0.0.1:15432 (the tunnel listener)`,
        () => probeHostTcp(ctx, '127.0.0.1', 15432),
      );
    } finally {
      // Clean shutdown — SIGINT mirrors what a builder would do
      // with Ctrl+C, dispatched to the tunnel's whole process group
      // (see `startBackground` — detached spawn puts the tunnel at
      // the head of its own pgroup so the signal reaches the
      // docker-run grandchild too).
      tunnel.signal('SIGINT');
      // Bounded wait. If the process hasn't exited within 5s,
      // escalate to SIGKILL so we never leave the scenario hanging
      // on a stuck child. Pre-Flight cleans any docker leftover.
      await Promise.race([
        tunnel.exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            tunnel.signal('SIGKILL');
            resolve();
          }, 5000),
        ),
      ]);
    }
  },
};

async function probePostgresFromWorkspace(ctx: ScenarioCtx): Promise<void> {
  const script = `for i in $(seq 1 30); do </dev/tcp/postgres/5432 && echo ok && exit 0; sleep 1; done; echo timeout; exit 1`;
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    `postgres:5432 reachable from workspace within 30s`,
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

/**
 * TCP-connect probe from the host. Retries for up to 15 attempts to
 * ride out socat startup latency (the `monoceros tunnel` warmup
 * already gives 2s, but the docker-run inside it adds image-pull on
 * first invocation).
 */
async function probeHostTcp(
  ctx: ScenarioCtx,
  host: string,
  port: number,
): Promise<void> {
  const attempts = 15;
  const delayMs = 500;
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await tryConnect(host, port);
      ctx.expect(`TCP connect to ${host}:${port} succeeds`, true);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await sleep(delayMs);
  }
  ctx.expect(
    `TCP connect to ${host}:${port} succeeds`,
    false,
    `after ${attempts} attempts (${(attempts * delayMs) / 1000}s): ${lastError?.message ?? 'unknown'}`,
  );
}

function tryConnect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy(new Error('TCP timeout'));
    });
    socket.once('error', (err) => {
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

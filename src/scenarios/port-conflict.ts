import { createServer, type Server } from 'node:net';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import { runDocker } from '../lib/docker.js';
import { withGlobalHostPort } from '../lib/global-config.js';

/**
 * `port-conflict` - proves the `apply` pre-flight CLASSIFIES who holds
 * the proxy host port instead of bailing with a generic "free the
 * port" line. Two distinguishable cases (workbench
 * `proxy/port-check.ts`):
 *
 *   1. A running container publishes the port → the message names that
 *      container and tells the builder to `docker stop` it.
 *   2. The port is held but NO container publishes it (a leftover
 *      docker-proxy, the classic native-dockerd-in-WSL orphan, or a
 *      holder in another Docker engine) → the message points at the
 *      leftover docker-proxy and a daemon restart, plus the
 *      `routing.hostPort` fallback.
 *
 * Mechanics:
 *   - `routing.hostPort` is steered onto a free HIGH port so the test
 *     never fights the real :80 (and needs no privileges). Restored in
 *     `finally`.
 *   - `monoceros-proxy` is removed first: the pre-flight skips entirely
 *     when our own proxy is the one holding the port ("held by us").
 *   - apply fails in the pre-flight BEFORE any container build, so both
 *     cases are fast (no devcontainer up).
 *
 * Bewusst NICHT abgebildet: ein ECHTER verwaister docker-proxy. Den
 * kann man portabel nicht on-demand erzeugen (bräuchte root / einen
 * Docker-Bug). Fall 2 triggert über den Host-Listener exakt denselben
 * Code-Pfad (`docker ps --filter publish=<port>` leer, Port belegt) und
 * damit dieselbe Meldung. Das Wording selbst ist zusätzlich im
 * Workbench-Unit-Test `proxy-port-check.test.ts` festgenagelt.
 */
const PROBE_PORT = 18099;

export const portConflict: Scenario = {
  id: 'port-conflict',
  description:
    'apply pre-flight classifies an occupied proxy port: live container (named) vs leftover/foreign holder',
  estimatedSeconds: 40,
  async run(ctx) {
    const hog = `${ctx.name}-hog`;
    let restoreConfig: (() => Promise<void>) | null = null;
    let listener: Server | null = null;

    try {
      restoreConfig = await ctx.step(
        `steer routing.hostPort onto the free test port ${PROBE_PORT}`,
        async () => {
          const restore = await withGlobalHostPort(PROBE_PORT);
          // The pre-flight skips when monoceros-proxy itself holds the
          // port ("held by us"). Drop it so the conflict path runs.
          await runDocker(['rm', '-f', 'monoceros-proxy']);
          return restore;
        },
      );

      await ctx.step(
        `init ${ctx.name} (ported → apply runs the pre-flight)`,
        () =>
          ctx.cli([
            'init',
            ctx.name,
            '--with-languages=node',
            '--with-ports=3000',
          ]),
      );

      // ---- Case 1: a live container publishes the port ---------------
      await ctx.step(
        `occupy :${PROBE_PORT} with a running container (${hog})`,
        async () => {
          await runDocker(['rm', '-f', hog]);
          const r = await runDocker([
            'run',
            '-d',
            '--name',
            hog,
            '-p',
            `${PROBE_PORT}:80`,
            'traefik/whoami',
          ]);
          ctx.expect(
            `docker run ${hog} succeeds`,
            r.exitCode === 0,
            r.stderr.trim() || `exit ${r.exitCode}`,
          );
        },
      );

      await ctx.step(
        `apply fails and NAMES the live container holding the port`,
        async () => {
          const out = await applyOutput(ctx);
          ctx.expect(
            'message: published by a running container',
            /published by a running container/.test(out),
            truncate(out),
          );
          ctx.expect(
            `message names the offending container (${hog})`,
            out.includes(hog),
            truncate(out),
          );
        },
      );

      await ctx.step(`free :${PROBE_PORT} (remove ${hog})`, async () => {
        await runDocker(['rm', '-f', hog]);
      });

      // ---- Case 2: held, but no container publishes it ---------------
      await ctx.step(
        `occupy :${PROBE_PORT} with a non-docker host listener`,
        async () => {
          listener = await listenOn(PROBE_PORT);
        },
      );

      await ctx.step(
        `apply fails with the leftover-holder hint + daemon-restart fix`,
        async () => {
          const out = await applyOutput(ctx);
          ctx.expect(
            'message: no running container publishes it',
            /no running container publishes it/.test(out),
            truncate(out),
          );
          ctx.expect(
            'message points at the leftover docker-proxy + a daemon restart',
            /docker-proxy/.test(out) && /systemctl restart docker/.test(out),
            truncate(out),
          );
          ctx.expect(
            'message offers the routing.hostPort fallback',
            /routing:/.test(out) && /hostPort/.test(out),
            truncate(out),
          );
        },
      );
    } finally {
      if (listener) await closeServer(listener);
      await runDocker(['rm', '-f', hog]);
      if (restoreConfig) await restoreConfig();
    }
  },
};

/** Run apply, assert it aborts non-zero, return combined output. */
async function applyOutput(ctx: ScenarioCtx): Promise<string> {
  const r = await ctx.cliCapture(['apply', ctx.name, '--yes']);
  const out = r.stdout + r.stderr;
  ctx.expect(
    'apply exits non-zero on the port conflict',
    r.exitCode !== 0,
    `exit ${r.exitCode}: ${truncate(out)}`,
  );
  return out;
}

/**
 * Bind a plain TCP listener on `127.0.0.1:<port>` - the address the
 * pre-flight's connect-probe targets. High port, so no privilege is
 * needed. Retries briefly on EADDRINUSE to ride out the just-removed
 * docker-proxy releasing the port.
 */
async function listenOn(port: number): Promise<Server> {
  const attempts = 20;
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await tryListen(port);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EADDRINUSE') throw e;
      lastErr = e;
      await sleep(250);
    }
  }
  throw new Error(
    `could not bind 127.0.0.1:${port} after ${attempts} attempts: ${lastErr?.message ?? 'unknown'}`,
  );
}

function tryListen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      s.removeListener('error', reject);
      resolve(s);
    });
  });
}

function closeServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

function truncate(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

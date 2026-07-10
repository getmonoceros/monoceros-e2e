import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import { runDocker } from '../lib/docker.js';
import { withGlobalHostPort } from '../lib/global-config.js';
import {
  startBackground,
  type BackgroundCliHandle,
} from '../lib/cli-background.js';

/**
 * `alt-hostport` - exercises a NON-default `routing.hostPort` end to
 * end and proves the three things that change (and the one that must
 * NOT) when the Traefik proxy moves off :80:
 *
 *   1. Briefing: the AGENTS.md `.localhost` URLs carry the `:<port>`
 *      suffix. Without it an agent is handed a dead `:80` URL. (The
 *      suffix-only-when-!=-80 logic is unit-tested in the workbench;
 *      here we prove `routing.hostPort` actually reaches the briefing
 *      through a real apply.)
 *   2. Routing: `http://<name>.localhost:<port>/` reaches the app via
 *      the proxy bound to the alt port.
 *   3. Share is INDEPENDENT of the proxy port: `monoceros share`
 *      forwards the app's own ports via a socat sidecar, never through
 *      Traefik - so it keeps working unchanged with a non-80 hostPort.
 *
 * Mechanics: `routing.hostPort` is steered onto a free HIGH port and
 * restored in `finally`; `monoceros-proxy` is dropped first so
 * `ensureProxy` binds a fresh one on the alt port (it reuses a running
 * proxy by NAME, ignoring the port, so a stale :80 proxy would
 * otherwise win).
 */
const ALT_PORT = 18080;
const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';
/** The cloned fixture dir name = the `share <name> <app>` app argument. */
const APP = 'monoceros-e2e-fixture';
/** ports[0] = the default route, and the port we probe for share. */
const APP_PORT = 5173;
const SECOND_PORT = 3001;

export const altHostport: Scenario = {
  id: 'alt-hostport',
  description:
    'routing.hostPort != 80: briefing URLs carry the :port suffix, routing works on the alt port, share is unaffected',
  estimatedSeconds: 180,
  async run(ctx) {
    let restoreConfig: (() => Promise<void>) | null = null;
    let share: BackgroundCliHandle | null = null;

    try {
      restoreConfig = await ctx.step(
        `steer routing.hostPort onto ${ALT_PORT}`,
        async () => {
          const restore = await withGlobalHostPort(ALT_PORT);
          // ensureProxy reuses a running monoceros-proxy by name and
          // ignores the configured port, so a proxy still bound to :80
          // from an earlier scenario would never rebind to ALT_PORT.
          // Drop it so apply creates a fresh one on ALT_PORT.
          await runDocker(['rm', '-f', 'monoceros-proxy']);
          return restore;
        },
      );

      await ctx.step(
        `init ${ctx.name} (ports ${APP_PORT},${SECOND_PORT} + fixture)`,
        () =>
          ctx.cli([
            'init',
            ctx.name,
            '--with-languages=node',
            `--with-ports=${APP_PORT},${SECOND_PORT}`,
            `--with-repos=${FIXTURE_REPO}`,
          ]),
      );

      await ctx.step(`apply ${ctx.name}`, () =>
        ctx.cli(['apply', ctx.name, '--yes']),
      );

      await ctx.step(
        `AGENTS.md .localhost URLs carry the :${ALT_PORT} suffix`,
        () => assertBriefingSuffix(ctx),
      );

      await ctx.step(
        `serve ${APP_PORT}+${SECOND_PORT} inside the container`,
        () => startServeBackground(ctx, [APP_PORT, SECOND_PORT]),
      );

      await ctx.step(
        `routing on the alt port: http://${ctx.name}.localhost:${ALT_PORT}/ returns ${APP_PORT}`,
        () =>
          waitForRoute(
            ctx,
            `http://${ctx.name}.localhost:${ALT_PORT}/`,
            APP_PORT,
          ),
      );

      // ---- share is independent of routing.hostPort -----------------
      share = await ctx.step(
        `start \`monoceros share ${ctx.name} ${APP}\` (background)`,
        () => startBackground(['share', ctx.name, APP], { warmupMs: 3000 }),
      );

      await ctx.step(
        `host TCP-connects to 127.0.0.1:${APP_PORT} (share forward, not via :${ALT_PORT})`,
        () => probeHostTcp(ctx, '127.0.0.1', APP_PORT),
      );
    } finally {
      if (share) {
        share.signal('SIGINT');
        await Promise.race([
          share.exited,
          new Promise<void>((resolve) =>
            setTimeout(() => {
              share!.signal('SIGKILL');
              resolve();
            }, 5000),
          ),
        ]);
      }
      if (restoreConfig) await restoreConfig();
    }
  },
};

async function assertBriefingSuffix(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'cat',
    `/workspaces/${ctx.name}/AGENTS.md`,
  ]);
  ctx.expect(
    'cat AGENTS.md exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim()}`,
  );
  const body = result.stdout;
  ctx.expect(
    `default route shows http://${ctx.name}.localhost:${ALT_PORT}`,
    body.includes(`http://${ctx.name}.localhost:${ALT_PORT}`),
    'port-less default route - hostPort did not reach the briefing',
  );
  ctx.expect(
    `secondary route shows http://${ctx.name}-${SECOND_PORT}.localhost:${ALT_PORT}`,
    body.includes(`http://${ctx.name}-${SECOND_PORT}.localhost:${ALT_PORT}`),
    'secondary route missing the :port suffix',
  );
  ctx.expect(
    'no port-less .localhost default route slipped through',
    !new RegExp(`http://${ctx.name}\\.localhost(?![:0-9])`).test(body),
    'found a suffix-free <name>.localhost URL',
  );
}

/**
 * Start serve-ports.mjs in the background inside the container - same
 * `nohup … & disown` pattern as `with-port`. No assertion here; the
 * route + share probes are the real proof.
 */
async function startServeBackground(
  ctx: ScenarioCtx,
  ports: number[],
): Promise<void> {
  const portArgs = ports.join(' ');
  await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `nohup node ${FIXTURE_DIR}/serve-ports.mjs ${portArgs} > /tmp/serve-ports.log 2>&1 & disown; sleep 1; echo started`,
  ]);
}

/**
 * HTTP-probe a `<name>.localhost:<altPort>/` URL through the Traefik
 * singleton and assert the JSON `port` field. Connects to 127.0.0.1
 * with an explicit Host header (Traefik routes by Host regardless of
 * interface) - same cross-OS-safe shape as `with-port`.
 */
async function waitForRoute(
  ctx: ScenarioCtx,
  url: string,
  expectedPort: number,
): Promise<void> {
  const attempts = 20;
  const delayMs = 500;
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = await fetchJson(url);
      if (body.port === expectedPort) {
        ctx.expect(`${url} returns port ${expectedPort}`, true);
        return;
      }
      lastError = new Error(
        `body.port = ${body.port}, expected ${expectedPort}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await sleep(delayMs);
  }
  ctx.expect(
    `${url} returns port ${expectedPort}`,
    false,
    `after ${attempts} attempts (${(attempts * delayMs) / 1000}s): ${lastError?.message ?? 'unknown error'}`,
  );
}

interface ProbeBody {
  port?: number;
}

function fetchJson(url: string): Promise<ProbeBody> {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const hostHeader = parsed.port
    ? `${parsed.hostname}:${port}`
    : parsed.hostname;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Host: hostHeader },
      },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err instanceof Error ? err : new Error('JSON parse failed'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('request timeout (2s)'));
    });
    req.end();
  });
}

/** TCP-connect probe from the host - same shape as `with-tunnel`. */
async function probeHostTcp(
  ctx: ScenarioCtx,
  host: string,
  port: number,
): Promise<void> {
  // Generous budget: the first `monoceros share` pulls the Caddy terminator
  // image, which can outlast a short window.
  const attempts = 40;
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

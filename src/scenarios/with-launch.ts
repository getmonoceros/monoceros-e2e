import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import {
  startBackground,
  type BackgroundCliHandle,
} from '../lib/cli-background.js';
import { runDocker } from '../lib/docker.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const APP = 'monoceros-e2e-fixture';
const SOCAT_IMAGE = 'alpine/socat:1.8.0.3';

/**
 * `with-launch` — the per-app launch-config lifecycle (ADR 0027/0028)
 * plus `monoceros share` (ADR 0030), end-to-end against the real
 * runtime runner (`monoceros-ctl`), which nothing else covers.
 *
 * The fixture ships `.monoceros/launch.json` with three targets:
 * `frontend` (5173, default), `api` (3001, default) and `storybook`
 * (6006, NOT default), each running serve-ports.mjs on its port.
 *
 * What it proves:
 *   - `start <name> <app>` (no --target) brings up the **default set**:
 *     5173 and 3001 are reachable immediately, 6006 is not.
 *   - `start <name> <app> --target storybook` brings up the non-default
 *     target on demand: 6006 becomes reachable.
 *   - `share <name> <app>` forwards **every configured port** (all
 *     three) to the host's `0.0.0.0` as socat sidecars, and Ctrl+C
 *     (SIGINT) tears every one of them down.
 *
 * Reachability is probed over the Traefik singleton on :80 by Host
 * header (same technique as `with-port`); the socat sidecars are
 * checked via `docker ps`.
 */
export const withLaunch: Scenario = {
  id: 'with-launch',
  description:
    'launch config: default set reachable on start, non-default target on `--target`, then `share` exposes all configured ports + cleans up',
  estimatedSeconds: 200,
  async run(ctx) {
    const name = ctx.name;

    await ctx.step(`init ${name} (node, ports 5173/3001/6006, fixture)`, () =>
      ctx.cli([
        'init',
        name,
        '--with-languages=node',
        '--with-ports=5173,3001,6006',
        `--with-repos=${FIXTURE_REPO}`,
      ]),
    );

    await ctx.step(`apply ${name}`, () => ctx.cli(['apply', name, '--yes']));

    // Default set: frontend (5173) + api (3001), NOT storybook.
    await ctx.step(`start ${name} ${APP} (default set)`, () =>
      ctx.cli(['start', name, APP]),
    );

    await ctx.step(`default ports reachable now: 5173 + 3001`, async () => {
      await waitForRoute(ctx, `http://${name}-5173.localhost/`, 5173);
      await waitForRoute(ctx, `http://${name}-3001.localhost/`, 3001);
    });

    await ctx.step(`non-default 6006 (storybook) NOT reachable yet`, () =>
      expectUnreachable(ctx, `http://${name}-6006.localhost/`),
    );

    await ctx.step(`start ${name} ${APP} --target storybook`, () =>
      ctx.cli(['start', name, APP, '--target', 'storybook']),
    );

    await ctx.step(`6006 reachable only after the explicit start`, () =>
      waitForRoute(ctx, `http://${name}-6006.localhost/`, 6006),
    );

    // share: every configured port forwarded to 0.0.0.0, foreground.
    const share = await ctx.step(
      `start \`monoceros share ${name} ${APP}\` (background)`,
      (): Promise<BackgroundCliHandle> =>
        startBackground(['share', name, APP], { warmupMs: 3000 }),
    );
    try {
      await ctx.step(
        `share exposes all 3 configured ports as 0.0.0.0 socat sidecars`,
        () => expectSocatPorts(ctx, [3001, 5173, 6006]),
      );
    } finally {
      // SIGINT to the whole group mirrors a terminal Ctrl+C and reaches
      // the docker-run grandchildren (see startBackground).
      share.signal('SIGINT');
      await Promise.race([
        share.exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            share.signal('SIGKILL');
            resolve();
          }, 5000),
        ),
      ]);
    }

    await ctx.step(`share cleaned up its sidecars on Ctrl+C`, () =>
      expectSocatPorts(ctx, []),
    );
  },
};

/** Among our three ports, which are currently published by a socat sidecar. */
async function sharedPorts(): Promise<number[]> {
  const res = await runDocker([
    'ps',
    '--filter',
    `ancestor=${SOCAT_IMAGE}`,
    '--format',
    '{{.Ports}}',
  ]);
  const ours = new Set([3001, 5173, 6006]);
  const found = new Set<number>();
  for (const m of res.stdout.matchAll(/0\.0\.0\.0:(\d+)->/g)) {
    const p = Number(m[1]);
    if (ours.has(p)) found.add(p);
  }
  return [...found].sort((a, b) => a - b);
}

/** Assert the set of our ports published by socat equals `expected`. */
async function expectSocatPorts(
  ctx: ScenarioCtx,
  expected: number[],
): Promise<void> {
  const attempts = 12;
  const delayMs = 500;
  let last: number[] = [];
  const want = [...expected].sort((a, b) => a - b).join(',');
  for (let i = 0; i < attempts; i++) {
    last = await sharedPorts();
    if (last.join(',') === want) {
      ctx.expect(`socat sidecars for ports [${want || 'none'}]`, true);
      return;
    }
    await sleep(delayMs);
  }
  ctx.expect(
    `socat sidecars for ports [${want || 'none'}]`,
    false,
    `after ${(attempts * delayMs) / 1000}s saw [${last.join(',') || 'none'}]`,
  );
}

interface ProbeOptions {
  attempts?: number;
  delayMs?: number;
}

/** HTTP-probe `url` via Traefik (Host header) until it returns the expected port. */
async function waitForRoute(
  ctx: ScenarioCtx,
  url: string,
  expectedPort: number,
  options: ProbeOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 500;
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

/**
 * Assert `url` is NOT serving (the target's process isn't running).
 * The Traefik route exists - the port is declared - so the proxy
 * answers, but with no backend listener it returns a 5xx and never a
 * 200 JSON body. Probe a few times and fail if it ever looks live.
 */
async function expectUnreachable(ctx: ScenarioCtx, url: string): Promise<void> {
  const attempts = 5;
  const delayMs = 400;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = await fetchJson(url);
      if (typeof body.port === 'number') {
        ctx.expect(
          `${url} is not reachable before its target is started`,
          false,
          `got a live response (port ${body.port})`,
        );
        return;
      }
    } catch {
      // expected: no backend → 5xx / connection error
    }
    await sleep(delayMs);
  }
  ctx.expect(`${url} is not reachable before its target is started`, true);
}

interface ProbeBody {
  port?: number;
  label?: string;
  host?: string;
}

function fetchJson(url: string): Promise<ProbeBody> {
  // Connect to 127.0.0.1 with the original hostname as the Host header,
  // so Traefik routes by Host regardless of how `*.localhost` resolves
  // on the host OS (WSL's Windows resolver does not honor RFC 6761).
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';

/**
 * `with-port` — zwei parallel laufende Container hinter dem
 * Traefik-Singleton, plus add-port mid-flight inkl. Persistenz nach
 * re-apply.
 *
 * Was es beweist:
 *   - Hostname-Routing isoliert zwei Container auf dem gleichen
 *     internen Port: beide servieren intern auf 3000, der Host
 *     adressiert sie über `<name>.localhost` und `<name>-2.localhost`.
 *   - `monoceros add-port` triggert Traefik-Hot-Reload, ohne den
 *     Container neu zu bauen.
 *   - Der hinzugefügte Port persistiert in der yml — ein erneutes
 *     `monoceros apply` republiziert die Route automatisch.
 *
 * Zwei-Container-Setup: der primary nutzt `ctx.name` (Framework
 * verwaltet Teardown), der sibling heißt `${ctx.name}-2` und wird
 * vom Szenario selbst aufgeräumt. Beide starten mit `e2e-` →
 * Pre-Flight-Cleanup matcht.
 */
export const withPort: Scenario = {
  id: 'with-port',
  description:
    'Two parallel containers route via Traefik hostnames; add-port mid-flight + persistence after re-apply',
  estimatedSeconds: 180,
  async run(ctx) {
    const a = ctx.name;
    const b = `${ctx.name}-2`;

    await ctx.step(`init ${a} (port 3000 + fixture)`, async () => {
      await ctx.cli([
        'init',
        a,
        '--with-languages=node',
        '--with-ports=3000',
        `--with-repos=${FIXTURE_REPO}`,
      ]);
    });

    await ctx.step(`init ${b} (port 3000 + fixture)`, async () => {
      await ctx.cli([
        'init',
        b,
        '--with-languages=node',
        '--with-ports=3000',
        `--with-repos=${FIXTURE_REPO}`,
      ]);
    });

    await ctx.step(`apply ${a}`, () => ctx.cli(['apply', a, '--yes']));
    await ctx.step(`apply ${b}`, () => ctx.cli(['apply', b, '--yes']));

    await ctx.step(
      `start serve-ports (3000+5173) in both containers`,
      async () => {
        await startServeBackground(ctx, a, [3000, 5173]);
        await startServeBackground(ctx, b, [3000, 5173]);
      },
    );

    await ctx.step(
      `both containers reachable on their hostname routes (port 3000)`,
      async () => {
        await waitForRoute(ctx, `http://${a}.localhost/`, 3000);
        await waitForRoute(ctx, `http://${b}.localhost/`, 3000);
      },
    );

    await ctx.step(`add-port ${a} 5173 (mid-flight, hot-reload)`, () =>
      ctx.cli(['add-port', a, '5173', '--yes']),
    );

    await ctx.step(
      `http://${a}-5173.localhost/ reachable, returns port 5173`,
      () => waitForRoute(ctx, `http://${a}-5173.localhost/`, 5173),
    );

    await ctx.step(
      `${b} unaffected by sibling's add-port (isolation check)`,
      () => waitForRoute(ctx, `http://${b}.localhost/`, 3000),
    );

    await ctx.step(`re-apply ${a} (force-recreates the container)`, () =>
      ctx.cli(['apply', a, '--yes']),
    );

    await ctx.step(
      `re-start serve-ports in ${a} (container was recreated)`,
      () => startServeBackground(ctx, a, [3000, 5173]),
    );

    await ctx.step(
      `port 5173 persists across re-apply — route still works`,
      () => waitForRoute(ctx, `http://${a}-5173.localhost/`, 5173),
    );

    // Success path: tear down the sibling explicitly. The framework
    // handles `ctx.name` (the primary) on its way out. On failure
    // (any `expect` above throws) we skip this and Pre-Flight cleans
    // both on the next run — same model the framework uses.
    await ctx.step(`remove sibling ${b}`, () =>
      ctx.cli(['remove', b, '--no-backup', '--yes']),
    );
  },
};

/**
 * Start serve-ports.mjs in the background inside the named container.
 *
 * The `nohup … & disown` pattern lets `monoceros run`'s exec call
 * return immediately while the node process keeps running for the
 * lifetime of the workspace container. Output redirects to
 * /tmp/serve-ports.log inside the container — accessible via
 * `monoceros shell` if you need to debug a failed probe.
 *
 * No assertion here — if the start fails, the route probe a step
 * later will time out with a meaningful "after N attempts" message.
 * Asserting on `started` here would just add noise; the real proof
 * is the HTTP probe.
 */
async function startServeBackground(
  ctx: ScenarioCtx,
  name: string,
  ports: number[],
): Promise<void> {
  const portArgs = ports.join(' ');
  await ctx.cliCapture([
    'run',
    name,
    '--',
    'bash',
    '-c',
    `nohup node ${FIXTURE_DIR}/serve-ports.mjs ${portArgs} > /tmp/serve-ports.log 2>&1 & disown; sleep 1; echo started`,
  ]);
}

interface ProbeOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * HTTP-probe a URL from the HOST (i.e. via the Traefik singleton on
 * port 80), parse the JSON body, and assert the `port` field equals
 * the expected value.
 *
 * The probe retries up to 20 times with 500ms gaps to ride out
 * Traefik's hot-reload latency (typically <1s) and the
 * post-`apply` settle period. One `ctx.expect` call total per probe
 * — succeeds early or reports the cumulative failure once.
 */
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

interface ProbeBody {
  port?: number;
  label?: string;
  host?: string;
}

function fetchJson(url: string): Promise<ProbeBody> {
  // Connect to 127.0.0.1 explicitly and pass the original hostname as
  // the Host header. Why: WSL Ubuntu's default /etc/resolv.conf
  // points at the Windows-side resolver, which does NOT auto-resolve
  // `*.localhost` to 127.0.0.1 — `http.request` then errors with
  // ENOTFOUND. Native Linux (systemd-resolved) and macOS (mDNSResponder)
  // do honor RFC 6761 here, but going through 127.x + explicit Host
  // header is identical-wire-behavior on all three (Traefik routes by
  // Host header regardless of which interface the connection arrived
  // on), so this branch is unconditional.
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const hostHeader = parsed.port ? `${parsed.hostname}:${port}` : parsed.hostname;
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
    });
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

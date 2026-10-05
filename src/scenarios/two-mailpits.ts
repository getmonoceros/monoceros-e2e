import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import {
  startBackground,
  type BackgroundCliHandle,
} from '../lib/cli-background.js';
import { runDocker } from '../lib/docker.js';

const PROXY_NETWORK = 'monoceros-proxy';
const MAILPIT_HTTP = 8025;
const PROBE_IMAGE = 'alpine:3.21';

/**
 * `two-mailpits` - two workbenches on one machine that run the same exposed
 * service, and the names they answer to (workbench #124).
 *
 * A service with an `httpPort` sits on the machine-wide `monoceros-proxy`
 * network so Traefik can route `<workbench>-<service>.localhost` to it. When
 * compose put it there, compose also gave it its service name on that network,
 * so two workbenches' keycloaks both answered to `keycloak` and an app reached
 * the other workbench's instance about every second request. Every workspace
 * with ports answered to `workspace` there the same way.
 *
 * Mailpit stands in for Keycloak: same `httpPort` path, starts in seconds, and
 * its API lets each workbench leave a marker mail that says which instance
 * answered.
 *
 * What it proves:
 *   - On `monoceros-proxy` the scenario's containers carry their prefixed alias
 *     and neither `mailpit` nor `workspace`; the bare names resolve to none of
 *     them, each prefixed alias to exactly one.
 *   - Inside each workbench `mailpit` resolves to its own instance only, and
 *     every read from the workspace returns its own marker.
 *   - Both `<workbench>-mailpit.localhost` routes answer with their own marker.
 *   - `share` serves the mailpit of the workbench it was started for.
 *   - The membership survives a `docker restart` of the service, and a
 *     `stop --down` + `start` (fresh containers) joins them again.
 *
 * Bare-name checks are scoped to the scenario's own containers: a machine
 * with workbenches applied by an older CLI still has bare aliases on the
 * network, and those are not this run's to judge.
 */
export const twoMailpits: Scenario = {
  id: 'two-mailpits',
  description:
    'two workbenches with mailpit: unique names on monoceros-proxy, each workspace + route + share reaches its own instance, membership survives restart and stop --down',
  estimatedSeconds: 90,
  async run(ctx) {
    const a = ctx.name;
    const b = `${ctx.name}-2`;

    for (const name of [a, b]) {
      await ctx.step(`init ${name} (mailpit, port 3000)`, () =>
        ctx.cli(['init', name, '--with-services=mailpit', '--with-ports=3000']),
      );
    }
    await ctx.step(`apply ${a}`, () => ctx.cli(['apply', a, '--yes']));
    await ctx.step(`apply ${b}`, () => ctx.cli(['apply', b, '--yes']));

    for (const name of [a, b]) {
      await ctx.step(`${name} sends a marker mail to its own mailpit`, () =>
        sendMarker(ctx, name),
      );
    }

    await ctx.step(
      `monoceros-proxy carries prefixed aliases only`,
      async () => {
        for (const name of [a, b]) {
          const ws = await proxyEndpoint(`monoceros-${name}`);
          ctx.expect(
            `monoceros-${name} on ${PROXY_NETWORK} as \`${name}\`, not \`workspace\``,
            ws?.names.includes(name) && !ws.names.includes('workspace'),
            JSON.stringify(ws),
          );
          const mp = await proxyEndpoint(
            await serviceContainer(name, 'mailpit'),
          );
          ctx.expect(
            `${name}'s mailpit on ${PROXY_NETWORK} as \`${name}-mailpit\`, not \`mailpit\``,
            mp?.names.includes(`${name}-mailpit`) &&
              !mp.names.includes('mailpit'),
            JSON.stringify(mp),
          );
        }
      },
    );

    await ctx.step(
      `names on monoceros-proxy resolve to one container each`,
      () => expectProxyResolution(ctx, a, b),
    );

    for (const name of [a, b]) {
      await ctx.step(`inside ${name}, \`mailpit\` is its own instance`, () =>
        expectOwnMailpit(ctx, name),
      );
    }

    await ctx.step(`both routes answer with their own marker`, async () => {
      await expectRoute(ctx, a);
      await expectRoute(ctx, b);
    });

    const share = await ctx.step(
      `start \`monoceros share ${a} none\` (background)`,
      (): Promise<BackgroundCliHandle> =>
        startBackground(['share', a, 'none'], { warmupMs: 3000 }),
    );
    try {
      await ctx.step(`share serves ${a}'s mailpit on :${MAILPIT_HTTP}`, () =>
        expectShare(ctx, a),
      );
    } finally {
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

    await ctx.step(
      `docker restart ${a}'s mailpit keeps its route`,
      async () => {
        const id = await serviceContainer(a, 'mailpit');
        const res = await runDocker(['restart', id]);
        ctx.expect(
          `docker restart ${id}`,
          res.exitCode === 0,
          res.stderr.trim(),
        );
        // Mailpit keeps mail in memory, so the restart dropped the marker.
        await sendMarker(ctx, a);
        await expectRoute(ctx, a);
      },
    );

    await ctx.step(`stop --down ${a}`, () => ctx.cli(['stop', a, '--down']));
    await ctx.step(`start ${a} (fresh containers)`, () =>
      ctx.cli(['start', a]),
    );
    await ctx.step(
      `after stop --down + start: same names, route back`,
      async () => {
        // `--down` drops mailpit's container, and with it the marker mail.
        await sendMarker(ctx, a);
        await expectProxyResolution(ctx, a, b);
        await expectRoute(ctx, a);
      },
    );

    await ctx.step(`remove sibling ${b}`, () =>
      ctx.cli(['remove', b, '--no-backup', '--yes']),
    );
  },
};

const marker = (name: string) => `marker ${name}`;

/** Leave the marker in the workbench's own mailpit, via the HTTP send API. */
async function sendMarker(ctx: ScenarioCtx, name: string): Promise<void> {
  const body = JSON.stringify({
    From: { Email: 'e2e@example.test' },
    To: [{ Email: 'inbox@example.test' }],
    Subject: marker(name),
    Text: name,
  });
  const script = `for i in $(seq 1 30); do curl -sf -X POST -H 'Content-Type: application/json' -d '${body}' http://mailpit:${MAILPIT_HTTP}/api/v1/send >/dev/null && echo ok && exit 0; sleep 1; done; exit 1`;
  const res = await ctx.cliCapture(['run', name, '--', 'bash', '-c', script]);
  ctx.expect(
    `marker mail sent from ${name}`,
    res.exitCode === 0 && res.stdout.trim().endsWith('ok'),
    `exit ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim()}`,
  );
}

/** Subjects in a Mailpit `/api/v1/messages` reply. */
function subjects(json: string): string[] {
  const parsed = JSON.parse(json) as { messages?: { Subject?: string }[] };
  return (parsed.messages ?? []).map((m) => m.Subject ?? '');
}

/** Container id of a compose service of the workbench `name`. */
async function serviceContainer(
  name: string,
  service: string,
): Promise<string> {
  const res = await runDocker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${name}_devcontainer`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ]);
  return res.stdout.trim().split('\n')[0]?.trim() ?? '';
}

interface Endpoint {
  ip: string;
  names: string[];
}

/** A container's address and DNS names on `monoceros-proxy`, if it is there. */
async function proxyEndpoint(container: string): Promise<Endpoint | undefined> {
  return (await endpoints(container))[PROXY_NETWORK];
}

async function endpoints(container: string): Promise<Record<string, Endpoint>> {
  const res = await runDocker([
    'inspect',
    '--format',
    '{{json .NetworkSettings.Networks}}',
    container,
  ]);
  if (res.exitCode !== 0) return {};
  const raw = JSON.parse(res.stdout.trim()) as Record<
    string,
    { IPAddress: string; DNSNames: string[] | null; Aliases: string[] | null }
  >;
  return Object.fromEntries(
    Object.entries(raw).map(([net, ep]) => [
      net,
      {
        ip: ep.IPAddress,
        names: [...(ep.DNSNames ?? []), ...(ep.Aliases ?? [])],
      },
    ]),
  );
}

/** IPv4 addresses `host` resolves to from a throwaway container on the proxy network. */
async function resolveOnProxy(host: string): Promise<string[]> {
  const res = await runDocker([
    'run',
    '--rm',
    `--network=${PROXY_NETWORK}`,
    PROBE_IMAGE,
    'getent',
    'ahostsv4',
    host,
  ]);
  return addresses(res.exitCode === 0 ? res.stdout : '');
}

function addresses(getentOutput: string): string[] {
  const ips = getentOutput
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  return [...new Set(ips)].sort();
}

async function expectProxyResolution(
  ctx: ScenarioCtx,
  a: string,
  b: string,
): Promise<void> {
  const own: Record<string, string> = {};
  for (const name of [a, b]) {
    const ws = await proxyEndpoint(`monoceros-${name}`);
    const mp = await proxyEndpoint(await serviceContainer(name, 'mailpit'));
    ctx.expect(
      `${name}'s workspace and mailpit are on ${PROXY_NETWORK}`,
      ws && mp,
    );
    own[name] = ws!.ip;
    own[`${name}-mailpit`] = mp!.ip;
  }
  const ours = new Set(Object.values(own));
  for (const bare of ['mailpit', 'workspace']) {
    const ips = await resolveOnProxy(bare);
    ctx.expect(
      `\`${bare}\` on ${PROXY_NETWORK} resolves to none of this run's containers`,
      ips.every((ip) => !ours.has(ip)),
      `resolved to ${ips.join(', ')}; ours: ${JSON.stringify(own)}`,
    );
  }
  for (const [alias, ip] of Object.entries(own)) {
    const ips = await resolveOnProxy(alias);
    ctx.expect(
      `\`${alias}\` on ${PROXY_NETWORK} resolves to exactly ${ip}`,
      ips.length === 1 && ips[0] === ip,
      `resolved to ${ips.join(', ') || 'nothing'}`,
    );
  }
}

/**
 * From the workspace, `mailpit` is the workbench's own instance: by address,
 * and by what it answers on repeated reads (the bug showed as a coin flip).
 */
async function expectOwnMailpit(ctx: ScenarioCtx, name: string): Promise<void> {
  const ownIp = (await endpoints(await serviceContainer(name, 'mailpit')))[
    `${name}_devcontainer_default`
  ]?.ip;
  const res = await ctx.cliCapture([
    'run',
    name,
    '--',
    'getent',
    'ahostsv4',
    'mailpit',
  ]);
  const ips = addresses(res.stdout);
  ctx.expect(
    `\`mailpit\` in ${name} resolves to its own instance only (${ownIp})`,
    ips.length === 1 && ips[0] === ownIp,
    `resolved to ${ips.join(', ') || 'nothing'}`,
  );
  const reads = await ctx.cliCapture([
    'run',
    name,
    '--',
    'bash',
    '-c',
    `for i in $(seq 1 10); do curl -sf http://mailpit:${MAILPIT_HTTP}/api/v1/messages; echo; done`,
  ]);
  const replies = reads.stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'));
  ctx.expect(
    `10 reads of mailpit from ${name} all return its own marker`,
    replies.length === 10 &&
      replies.every(
        (r) => JSON.stringify(subjects(r)) === JSON.stringify([marker(name)]),
      ),
    replies.map((r) => subjects(r).join('|')).join(' ; ') ||
      reads.stderr.trim(),
  );
}

/** `<name>-mailpit.localhost` via Traefik answers with the workbench's own marker. */
async function expectRoute(ctx: ScenarioCtx, name: string): Promise<void> {
  const host = `${name}-mailpit.localhost`;
  const got = await retry(() =>
    get(httpRequest, { host: '127.0.0.1', port: 80, headers: { Host: host } }),
  );
  ctx.expect(
    `http://${host}/ answers with ${marker(name)}`,
    got.ok &&
      JSON.stringify(subjects(got.body)) === JSON.stringify([marker(name)]),
    got.error ?? got.body.slice(0, 300),
  );
}

/** The share terminator on :8025 answers with the shared workbench's marker. */
async function expectShare(ctx: ScenarioCtx, name: string): Promise<void> {
  const got = await retry(
    () =>
      get(httpsRequest, {
        host: '127.0.0.1',
        port: MAILPIT_HTTP,
        rejectUnauthorized: false,
      }),
    40,
  );
  ctx.expect(
    `https://127.0.0.1:${MAILPIT_HTTP}/ answers with ${marker(name)}`,
    got.ok &&
      JSON.stringify(subjects(got.body)) === JSON.stringify([marker(name)]),
    got.error ?? got.body.slice(0, 300),
  );
}

interface Got {
  ok: boolean;
  body: string;
  error?: string;
}

async function retry(fn: () => Promise<Got>, attempts = 20): Promise<Got> {
  let last: Got = { ok: false, body: '', error: 'not tried' };
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

function get(
  request: typeof httpRequest | typeof httpsRequest,
  opts: Record<string, unknown>,
): Promise<Got> {
  return new Promise((resolve) => {
    const req = request(
      { ...opts, path: '/api/v1/messages', method: 'GET' },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () =>
          resolve(
            res.statusCode === 200
              ? { ok: true, body }
              : { ok: false, body, error: `HTTP ${res.statusCode}` },
          ),
        );
      },
    );
    req.on('error', (err) =>
      resolve({ ok: false, body: '', error: err.message }),
    );
    req.setTimeout(2000, () => req.destroy(new Error('request timeout (2s)')));
    req.end();
  });
}

import type { Scenario, ScenarioCtx } from './scenario.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';

/**
 * Factory for a per-service e2e scenario, generalising `with-services`
 * (postgres) to any curated service: it `init`s a compose-mode container
 * with the service + the fixture repo, applies it, TCP-probes the
 * service port from the workspace, installs the fixture deps, then runs a
 * fixture probe script that **asserts the Monoceros-injected `<NAME>_*`
 * connection env** (ADR 0021) and does a real round-trip. A missing or
 * empty connection env therefore fails the e2e — the guard that the
 * old hardcoded-fallback probe lacked.
 */
export function makeServiceScenario(opts: {
  id: string;
  service: string;
  port: number;
  /** Fixture script run from the cloned repo, e.g. `mongo-client.mjs`. */
  probeScript: string;
  /** Human label for the probe step / expectation. */
  probeLabel: string;
  estimatedSeconds: number;
}): Scenario {
  return {
    id: opts.id,
    description: `init → apply → TCP-probe + ${opts.probeLabel} round-trip (asserts connection env) → remove (Compose-Mode, ${opts.service})`,
    estimatedSeconds: opts.estimatedSeconds,
    async run(ctx) {
      await ctx.step(
        `init ${ctx.name} --with-services=${opts.service} --with-repos=…/monoceros-e2e-fixture`,
        () =>
          ctx.cli([
            'init',
            ctx.name,
            '--with-languages=node',
            `--with-services=${opts.service}`,
            `--with-repos=${FIXTURE_REPO}`,
          ]),
      );

      await ctx.step(`apply ${ctx.name}`, () =>
        ctx.cli(['apply', ctx.name, '--yes']),
      );

      await ctx.step(
        `workspace can reach ${opts.service}:${opts.port} via DNS`,
        () => probeTcp(ctx, opts.service, opts.port),
      );

      await ctx.step(`install fixture deps (npm ci)`, () =>
        runInFixture(ctx, 'npm ci --no-audit --no-fund', 'npm ci succeeded'),
      );

      await ctx.step(`${opts.probeLabel} probe against ${opts.service}`, () =>
        runProbe(ctx, opts.probeScript, opts.probeLabel),
      );
    },
  };
}

async function probeTcp(
  ctx: ScenarioCtx,
  host: string,
  port: number,
): Promise<void> {
  const script = `for i in $(seq 1 30); do </dev/tcp/${host}/${port} && echo ok && exit 0; sleep 1; done; echo timeout; exit 1`;
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    `\`${host}:${port}\` reachable from workspace within 30s`,
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

async function runInFixture(
  ctx: ScenarioCtx,
  cmd: string,
  label: string,
): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && ${cmd}`,
  ]);
  ctx.expect(
    label,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
}

async function runProbe(
  ctx: ScenarioCtx,
  probeScript: string,
  label: string,
): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && node ${probeScript}`,
  ]);
  const tail = result.stdout.trim().split('\n').slice(-1)[0] ?? '';
  ctx.expect(
    `${label} probe exits 0`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
  ctx.expect(
    `${label} probe stdout ends with \`ok\``,
    tail === 'ok',
    `last line: ${JSON.stringify(tail)} — full: ${result.stdout.trim().slice(-400)}`,
  );
}

import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';

/**
 * `with-two-postgres` — the multi-DB-same-engine case ADR 0021 exists for.
 * A single postgres works with its canonical name; the real test is a
 * SECOND postgres added under a different name (`add-service postgres
 * --as=analytics`). Each instance must get its OWN connection env
 * (`POSTGRES_*` and `ANALYTICS_*`), distinct and non-empty — the
 * two-db-client probe asserts exactly that and round-trips against both.
 *
 * Regression guarded: the serializer once dropped the per-instance
 * connectionEnv block, so the renamed instance fell back to a
 * catalog-by-name lookup that missed and got no env at all. That would
 * fail here on the missing `ANALYTICS_URL`.
 */
export const withTwoPostgres: Scenario = {
  id: 'with-two-postgres',
  description:
    'init postgres + add-service --as=analytics → apply → probe asserts POSTGRES_* AND ANALYTICS_* (distinct) + round-trips both → remove',
  estimatedSeconds: 180,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-services=postgres --with-repos=…/monoceros-e2e-fixture`,
      () =>
        ctx.cli([
          'init',
          ctx.name,
          '--with-languages=node',
          '--with-services=postgres',
          `--with-repos=${FIXTURE_REPO}`,
        ]),
    );

    await ctx.step(`add-service ${ctx.name} postgres --as=analytics`, () =>
      ctx.cli(['add-service', ctx.name, 'postgres', '--as=analytics', '--yes']),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(
      'workspace can reach both postgres + analytics via DNS',
      () => probeBothTcp(ctx),
    );

    await ctx.step('install fixture deps (npm ci)', () =>
      runInFixture(ctx, 'npm ci --no-audit --no-fund', 'npm ci succeeded'),
    );

    await ctx.step('two-postgres probe (asserts both connection envs)', () =>
      runProbe(ctx),
    );
  },
};

async function probeBothTcp(ctx: ScenarioCtx): Promise<void> {
  const script = ['postgres', 'analytics']
    .map(
      (h) =>
        `for i in $(seq 1 30); do </dev/tcp/${h}/5432 && echo ${h}-ok && break; sleep 1; done`,
    )
    .join('; ');
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `${script}; echo done`,
  ]);
  ctx.expect(
    '`postgres:5432` and `analytics:5432` both reachable within 30s',
    result.exitCode === 0 &&
      result.stdout.includes('postgres-ok') &&
      result.stdout.includes('analytics-ok'),
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
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

async function runProbe(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && node two-db-client.mjs`,
  ]);
  const tail = result.stdout.trim().split('\n').slice(-1)[0] ?? '';
  ctx.expect(
    'two-postgres probe exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
  ctx.expect(
    'two-postgres probe stdout ends with `ok`',
    tail === 'ok',
    `last line: ${JSON.stringify(tail)} — full: ${result.stdout.trim().slice(-400)}`,
  );
}

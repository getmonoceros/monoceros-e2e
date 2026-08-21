import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `upgrade` — the runtime-image pinning lifecycle (ADR 0017).
 *
 * What it proves:
 *   - `monoceros init`            → succeeds (the yml is pinned to a
 *                                   concrete runtime version)
 *   - `monoceros apply`           → container comes up on the pinned
 *                                   (init-default) runtime
 *   - `monoceros upgrade --list`  → lists published runtime versions
 *                                   from the registry (anonymous GHCR
 *                                   token flow — no credentials)
 *   - `monoceros upgrade <name> 1.0.0`
 *                                 → re-pins the yml to a DIFFERENT,
 *                                   explicit version and re-applies on
 *                                   that image
 *   - the same run pulls a stale curated SERVICE tag up to the catalog
 *     (ADR 0052) — the path a CVE fix in an upstream image travels to a
 *     workbench that already exists. A regression here is silent: the
 *     upgrade still succeeds and the old image keeps running.
 *
 * Teardown (framework) removes the container + its volumes afterwards.
 *
 * Asserted via CLI behaviour only (exit codes + reported version), so
 * the scenario doesn't depend on MONOCEROS_HOME paths. The exact yml
 * rewrite + volume cleanup are covered by the workbench unit tests.
 */
export const upgrade: Scenario = {
  id: 'upgrade',
  description:
    'init (pinned, + postgres) → apply → upgrade --list → upgrade <name> 1.0.0 (re-pin + re-apply on a different image, stale service tag retagged)',
  estimatedSeconds: 180,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-languages=node --with-services=postgres`,
      async () => {
        const r = await ctx.cliCapture([
          'init',
          ctx.name,
          '--with-languages=node',
          '--with-services=postgres',
        ]);
        ctx.expect('init exits 0', r.exitCode === 0, r.stderr.trim());
      },
    );

    // What a workbench looks like once the catalog has moved on: the
    // service still carries the tag it was created with.
    let staleTag = '';
    await ctx.step('age the postgres tag in the yml', async () => {
      staleTag = agePostgresTag(ctx);
    });

    await ctx.step(`apply ${ctx.name} (init-pinned runtime)`, async () => {
      const code = await ctx.cli(['apply', ctx.name, '--yes']);
      ctx.expect('apply exits 0', code === 0, `exit ${code}`);
    });

    await ctx.step(
      'upgrade --list lists published runtime versions',
      async () => {
        const r = await ctx.cliCapture(['upgrade', '--list']);
        ctx.expect('upgrade --list exits 0', r.exitCode === 0, r.stderr.trim());
        ctx.expect(
          'lists at least one semver runtime version',
          /\d+\.\d+\.\d+/.test(r.stdout),
          `stdout: ${r.stdout.trim()}`,
        );
      },
    );

    await ctx.step(
      `upgrade ${ctx.name} 1.0.0 — re-pin to an explicit version + re-apply`,
      async () => {
        const r = await ctx.cliCapture(['upgrade', ctx.name, '1.0.0']);
        ctx.expect('upgrade exits 0', r.exitCode === 0, r.stderr.trim());
        ctx.expect(
          'reports the new pinned version 1.0.0',
          r.stdout.includes('1.0.0'),
          `stdout: ${r.stdout.trim()}`,
        );
        ctx.expect(
          'reports the retagged service',
          /retagged/.test(r.stdout),
          `stdout: ${r.stdout.trim()}`,
        );
      },
    );

    await ctx.step(
      'the stale service tag is gone from the yml (ADR 0052)',
      async () => {
        const yml = readYml(ctx);
        ctx.expect(
          `postgres no longer runs ${staleTag}`,
          !yml.includes(`image: ${staleTag}`),
          `yml still carries ${staleTag}`,
        );
        ctx.expect(
          'postgres still has a catalog image line',
          /^\s+image: postgres:\S+$/m.test(yml),
          'no postgres image line in the yml',
        );
      },
    );
  },
};

function ymlPath(ctx: ScenarioCtx): string {
  const home =
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    );
  return path.join(home, 'container-configs', `${ctx.name}.yml`);
}

function readYml(ctx: ScenarioCtx): string {
  return readFileSync(ymlPath(ctx), 'utf8');
}

/**
 * Rewrite the generated postgres tag to an old one, so `upgrade` has
 * something to pull forward. Returns the stale reference it wrote.
 *
 * `postgres:13` is deliberately an image that still exists upstream:
 * the re-pull has to succeed, otherwise the scenario would pass on a
 * failed pull rather than on a working retag.
 */
function agePostgresTag(ctx: ScenarioCtx): string {
  const target = ymlPath(ctx);
  const yml = readFileSync(target, 'utf8');
  const match = /^(\s+)image: (postgres:\S+)$/m.exec(yml);
  if (!match) {
    throw new Error(
      `no postgres image line in ${target} — did the curated postgres service change?`,
    );
  }
  const stale = 'postgres:13';
  writeFileSync(
    target,
    yml.replace(match[0], `${match[1]}image: ${stale}`),
    'utf8',
  );
  ctx.info(`aged ${match[2]} → ${stale}`);
  return stale;
}

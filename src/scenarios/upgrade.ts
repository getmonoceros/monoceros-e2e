import type { Scenario } from '../lib/scenario.js';

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
    'init (pinned) → apply → upgrade --list → upgrade <name> 1.0.0 (re-pin + re-apply on a different image)',
  estimatedSeconds: 150,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-languages=node`, async () => {
      const r = await ctx.cliCapture([
        'init',
        ctx.name,
        '--with-languages=node',
      ]);
      ctx.expect('init exits 0', r.exitCode === 0, r.stderr.trim());
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
      },
    );
  },
};

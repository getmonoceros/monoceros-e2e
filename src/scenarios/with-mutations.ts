import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-mutations` — realistische „Builder baut Container Stück für
 * Stück auf"-Strecke: nach dem initialen apply werden zwei
 * konfigurationsverändernde Befehle hintereinander gefeuert, dann
 * einmal re-applyed, dann verifiziert.
 *
 * Eine Strecke statt zwei Einzel-Szenarien, weil das den realen
 * Workflow trifft (Builder ruft mehrere `add-*` auf, applied dann
 * einmal) und einen Apply-Zyklus spart.
 *
 * Was es prüft:
 *   - `monoceros add-apt-packages <name> -- jq` — yml-Mutation +
 *     apt-get install im post-create-Pfad.
 *   - `monoceros add-feature <name> github` — Devcontainer-Feature-
 *     Install. Das ist die Lieferinfrastruktur für AI-Tools (Claude
 *     Code, Atlassian etc.); github-cli teilt den gleichen Pfad.
 *   - Beides überlebt den re-apply und ist im laufenden Container
 *     funktional.
 */
export const withMutations: Scenario = {
  id: 'with-mutations',
  description:
    'init → apply → add-apt-packages jq → add-feature github → re-apply → jq + gh verify',
  estimatedSeconds: 180,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-languages=node`, () =>
      ctx.cli(['init', ctx.name, '--with-languages=node']),
    );

    await ctx.step(`apply ${ctx.name} (initial)`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(`add-apt-packages ${ctx.name} jq`, () =>
      ctx.cli(['add-apt-packages', ctx.name, 'jq', '--yes']),
    );

    await ctx.step(`add-feature ${ctx.name} github`, () =>
      ctx.cli(['add-feature', ctx.name, 'github', '--yes']),
    );

    await ctx.step(
      `re-apply ${ctx.name} (rebuild needed for the feature install)`,
      () => ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(`jq --version reports a semver`, () =>
      assertCommandOutput(
        ctx,
        ['jq', '--version'],
        /^jq-\d+\.\d+/,
        'output starts with `jq-<MAJOR>.<MINOR>`',
      ),
    );

    await ctx.step(`gh --version reports a semver`, () =>
      assertCommandOutput(
        ctx,
        ['gh', '--version'],
        /^gh version \d+\.\d+\.\d+/,
        'output starts with `gh version <MAJOR>.<MINOR>.<PATCH>`',
      ),
    );
  },
};

async function assertCommandOutput(
  ctx: ScenarioCtx,
  argv: string[],
  pattern: RegExp,
  expectation: string,
): Promise<void> {
  const result = await ctx.cliCapture(['run', ctx.name, '--', ...argv]);
  ctx.expect(
    `\`${argv.join(' ')}\` exits 0`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
  // `gh --version` writes a two-line block; we only need the first.
  const firstLine = result.stdout.trim().split('\n')[0] ?? '';
  ctx.expect(
    expectation,
    pattern.test(firstLine),
    `first line: ${JSON.stringify(firstLine)}`,
  );
  ctx.info(`${argv[0]} reports: ${firstLine}`);
}

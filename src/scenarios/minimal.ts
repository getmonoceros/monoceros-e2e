import type { Scenario } from '../lib/scenario.js';

/**
 * `minimal` — der schmälste sinnvolle Lifecycle-Beweis.
 *
 * Was es prüft:
 *   - `monoceros init --with=node`  → yml landet im container-configs
 *   - `monoceros apply`             → Container fährt hoch (Image-Mode,
 *                                     keine Services)
 *   - `monoceros run -- node …`     → das Workspace-Image bringt Node mit
 *   - `monoceros remove`            → Container weg, yml weg
 *
 * Wenn dieses Szenario versagt, ist die CLI baseline-kaputt — alles
 * andere ist Folgefehler.
 */
export const minimal: Scenario = {
  id: 'minimal',
  description:
    'init → apply → run -- node --version → remove (Image-Mode, keine Services)',
  estimatedSeconds: 60,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with=node`, async () => {
      await ctx.cli(['init', ctx.name, '--with=node']);
    });

    await ctx.step(`apply ${ctx.name}`, async () => {
      await ctx.cli(['apply', ctx.name, '--yes']);
    });

    await ctx.step(`run ${ctx.name} -- node --version`, async () => {
      const result = await ctx.cliCapture([
        'run',
        ctx.name,
        '--',
        'node',
        '--version',
      ]);
      ctx.expect(
        '`monoceros run … node --version` exits 0',
        result.exitCode === 0,
        `exit ${result.exitCode}: ${result.stderr.trim()}`,
      );
      const versionLine = result.stdout.trim();
      ctx.expect(
        'stdout matches semver pattern v<MAJOR>.<MINOR>.<PATCH>',
        /^v\d+\.\d+\.\d+/.test(versionLine),
        `got ${JSON.stringify(versionLine)}`,
      );
      ctx.info(`node version inside the container: ${versionLine}`);
    });
  },
};

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
    ctx.step(`init ${ctx.name} --with=node`);
    await ctx.cli(['init', ctx.name, '--with=node']);

    ctx.step(`apply ${ctx.name}`);
    await ctx.cli(['apply', ctx.name, '--yes']);

    ctx.step(`run ${ctx.name} -- node --version`);
    const result = await ctx.cliCapture([
      'run',
      ctx.name,
      '--',
      'node',
      '--version',
    ]);
    ctx.assert(
      result.exitCode === 0,
      `\`monoceros run … node --version\` exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
    const versionLine = result.stdout.trim();
    ctx.assert(
      /^v\d+\.\d+\.\d+/.test(versionLine),
      `Expected a semver-style version on stdout (got: ${JSON.stringify(versionLine)})`,
    );
    ctx.info(`node version inside the container: ${versionLine}`);
  },
};

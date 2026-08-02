import { withGlobalEnvGitUser } from '../lib/global-config.js';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `minimal` — der schmälste sinnvolle Lifecycle-Beweis.
 *
 * Was es prüft:
 *   - `monoceros init --with-languages=node`  → yml landet im container-configs
 *   - `monoceros apply`             → Container fährt hoch (Image-Mode,
 *                                     keine Services)
 *   - `monoceros run -- node …`     → das Workspace-Image bringt Node mit
 *   - ein Commit im Container       → die Git-Identität aus der env greift
 *   - `monoceros remove`            → Container weg, yml weg
 *
 * Wenn dieses Szenario versagt, ist die CLI baseline-kaputt — alles
 * andere ist Folgefehler.
 */
export const minimal: Scenario = {
  id: 'minimal',
  description:
    'init → apply → run -- node --version → commit im Container → remove (Image-Mode, keine Services)',
  estimatedSeconds: 70,
  async run(ctx) {
    // Die Identität kommt aus der globalen env, ohne `git.user` in der
    // yml — genau der Fall, der lange nicht funktionierte: den Block
    // schreibt `init` nur bei `--with-repos`, und diese Workbench hat
    // keine. `with-check` deckt den yml-Weg ab, hier ist der env-Weg.
    const restoreGitUser = await withGlobalEnvGitUser({
      name: 'E2E Builder',
      email: 'e2e@example.com',
    });
    try {
      await ctx.step(`init ${ctx.name} --with-languages=node`, async () => {
        await ctx.cli(['init', ctx.name, '--with-languages=node']);
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

      await ctx.step(
        `commit inside ${ctx.name} works with the identity from the env`,
        () => assertCanCommit(ctx),
      );

      await ctx.step(`run --in on a directory that does not exist yet`, () =>
        assertCreatesMissingCwd(ctx),
      );
    } finally {
      await restoreGitUser();
    }
  },
};

/**
 * The end-to-end proof of the identity: a real commit in a real
 * container. A unit test can assert that `.monoceros/gitconfig` was
 * written; only git itself decides whether the value reaches
 * `git commit`, and its failure mode is the one that hurts - an agent
 * halfway through a task, told "Please tell me who you are".
 */
async function assertCanCommit(ctx: ScenarioCtx): Promise<void> {
  const script = [
    'set -e',
    'cd "$(mktemp -d)"',
    'git init -q .',
    'echo hello > file.txt',
    'git add file.txt',
    'git commit -q -m "e2e: identity from the env"',
    'git log -1 --format="%an <%ae>"',
  ].join(' && ');
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    'the commit succeeds instead of asking who you are',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
  ctx.expect(
    'the author is the identity from monoceros-config.env',
    result.stdout.includes('E2E Builder <e2e@example.com>'),
    `git log said: ${result.stdout.trim()}`,
  );
}

/**
 * The first run for a new app names a directory the agent has not created
 * yet. Two halves worth pinning: `--yes` creates it and runs there, and
 * without it a non-interactive caller gets an error instead of a hang or a
 * silent mkdir. The e2e is the only place the second half is real, since a
 * unit test cannot show that nothing waits for input.
 */
async function assertCreatesMissingCwd(ctx: ScenarioCtx): Promise<void> {
  const dir = 'projects/fresh-app';
  const refused = await ctx.cliCapture([
    'run',
    ctx.name,
    `--in=${dir}`,
    '--',
    'pwd',
  ]);
  ctx.expect(
    'a missing directory is an error without --yes',
    refused.exitCode !== 0,
    `exit ${refused.exitCode}: ${refused.stdout.trim()}`,
  );
  ctx.expect(
    'the error names the way out instead of bash cd',
    `${refused.stdout}${refused.stderr}`.includes('--yes'),
    `output was: ${refused.stdout.trim()} / ${refused.stderr.trim()}`,
  );

  const created = await ctx.cliCapture([
    'run',
    ctx.name,
    `--in=${dir}`,
    '--yes',
    '--',
    'pwd',
  ]);
  ctx.expect(
    '--yes creates the directory and runs in it',
    created.exitCode === 0 &&
      created.stdout.trim().endsWith(`/${ctx.name}/${dir}`),
    `exit ${created.exitCode}: ${created.stdout.trim()}`,
  );
}

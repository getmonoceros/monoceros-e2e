import path from 'node:path';
import type { Scenario } from '../lib/scenario.js';
import { dockerLocalFolderLabel, runDocker } from '../lib/docker.js';

/**
 * `image-mode-zombie` — regression guard for the M4-Task-9 fund.
 *
 * Background: image-mode dev containers (no Compose, e.g.
 * `--with=node` only) once survived `monoceros remove` because the
 * old remove pipeline filtered by `com.docker.compose.project`, which
 * doesn't apply to plain `docker run`-style containers. They were
 * left as zombies in `docker ps -a`. The fix used the
 * `devcontainer.local_folder` label as an additional anchor; this
 * scenario keeps that fix honest.
 *
 * Flow:
 *   1. `init --with=node` — image-mode, NO services.
 *   2. `apply` — container running.
 *   3. Assert a docker container exists under the local_folder label
 *      (so the rest of the scenario isn't probing nothing).
 *   4. `remove --no-backup --yes`.
 *   5. Assert NO containers remain under that label — anywhere in
 *      `docker ps -a`, running or stopped.
 *
 * The framework's automatic teardown after the scenario body is a
 * no-op here (the scenario already removed the container). That's
 * fine — `monoceros remove` is idempotent and just reports "nothing
 * to remove" on the second call.
 */
export const imageModeZombie: Scenario = {
  id: 'image-mode-zombie',
  description:
    'init → apply → remove → docker ps -a must have no containers for this dir (image-mode regression guard)',
  estimatedSeconds: 90,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with=node (image-mode, no services)`,
      () => ctx.cli(['init', ctx.name, '--with=node']),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    const containerDir = resolveContainerDir(ctx.name);

    await ctx.step(
      `apply produced a docker container under devcontainer.local_folder=${containerDir}`,
      async () => {
        const ids = await dockerPsByLabelFolder(containerDir);
        ctx.expect(
          `>= 1 docker container exists for ${containerDir}`,
          ids.length >= 1,
          `docker ps -aq returned: ${JSON.stringify(ids)}`,
        );
      },
    );

    await ctx.step(`remove ${ctx.name} --no-backup --yes`, () =>
      ctx.cli(['remove', ctx.name, '--no-backup', '--yes']),
    );

    await ctx.step(
      `NO docker container survives for ${containerDir} (the M4-Task-9 zombie)`,
      async () => {
        const ids = await dockerPsByLabelFolder(containerDir);
        ctx.expect(
          `docker ps -aq for ${containerDir} is empty`,
          ids.length === 0,
          `still around: ${JSON.stringify(ids)}`,
        );
      },
    );
  },
};

/**
 * Where the workbench materialises a container by name. Mirrors the
 * convention from packages/cli/src/config/paths.ts:
 * `$MONOCEROS_HOME/container/<name>/`. We can't import that, so we
 * recompute it here — same resolution rules.
 */
function resolveContainerDir(name: string): string {
  const home =
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    );
  return path.join(home, 'container', name);
}

/**
 * List docker container IDs (running OR stopped) carrying the
 * `devcontainer.local_folder=<dir>` label. That label is what
 * `@devcontainers/cli` writes on every container it creates,
 * regardless of image-mode vs compose-mode — making it the most
 * reliable anchor for "containers belonging to this dev-container
 * dir". The workbench's own `monoceros remove` uses the same anchor.
 *
 * Throws on docker failure rather than returning `[]` silently — a
 * permission-denied or daemon-down error has to surface, or the
 * regression-guard assertion would happily go green on a broken
 * setup.
 */
async function dockerPsByLabelFolder(containerDir: string): Promise<string[]> {
  const result = await runDocker([
    'ps',
    '-aq',
    '--filter',
    // dockerLocalFolderLabel() lowercases the drive letter on Windows
    // to match what @devcontainers/cli stamps (`c:\…` vs our
    // `path.join`-built `C:\…`); docker filters are byte-exact.
    `label=devcontainer.local_folder=${dockerLocalFolderLabel(containerDir)}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ps exited ${result.exitCode}: ${result.stderr.trim() || '<no stderr>'}`,
    );
  }
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

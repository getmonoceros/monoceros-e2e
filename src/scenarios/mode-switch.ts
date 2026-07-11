import path from 'node:path';
import type { Scenario } from '../lib/scenario.js';
import { runDocker } from '../lib/docker.js';

/**
 * `mode-switch` — regression guard for the image-mode → compose-mode
 * re-apply.
 *
 * Background: a container with NO services is materialised in image
 * mode — the workspace is `docker run --name=monoceros-<name>`, which
 * carries no `com.docker.compose.project` label. Adding the first
 * service flips it to compose mode. The apply pre-cleanup ran only the
 * compose filters (project label + `<project>-` name prefix), so the
 * leftover image-mode container matched neither and survived. The next
 * `up` then collided on the fixed `container_name: monoceros-<name>`
 * ("The container name is already in use") and apply failed. The fix
 * adds a third cleanup filter keyed on that fixed name — the one
 * identity both modes share.
 *
 * Flow:
 *   1. `init --with-languages=node` — image-mode, NO services.
 *   2. `apply` — image-mode container running.
 *   3. `add-service redis` — flips the yml to compose-mode.
 *   4. `apply` again — MUST succeed. Pre-fix this is where the stale
 *      image-mode container blocks the name and apply exits non-zero.
 *   5. Assert exactly ONE container under the dir's local_folder label —
 *      the image-mode leftover was swept, the compose workspace is up
 *      (no zombie left behind, no collision).
 */
export const modeSwitch: Scenario = {
  id: 'mode-switch',
  description:
    'init (image-mode) → apply → add-service redis → apply again must succeed, not collide on the fixed container name (image→compose regression guard)',
  estimatedSeconds: 180,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-languages=node (image-mode, no services)`,
      () => ctx.cli(['init', ctx.name, '--with-languages=node']),
    );

    await ctx.step(`apply ${ctx.name} (image-mode)`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(`add-service ${ctx.name} redis (flip to compose-mode)`, () =>
      ctx.cli(['add-service', ctx.name, 'redis', '--yes']),
    );

    await ctx.step(
      `apply ${ctx.name} again (compose-mode) must not collide on monoceros-${ctx.name}`,
      async () => {
        const result = await ctx.cliCapture(['apply', ctx.name, '--yes']);
        ctx.expect(
          're-apply after the mode switch exits 0',
          result.exitCode === 0,
          `exit ${result.exitCode}: ${result.stderr.trim().slice(-500) || result.stdout.trim().slice(-500)}`,
        );
      },
    );

    const containerDir = resolveContainerDir(ctx.name);

    await ctx.step(
      `exactly one docker container survives for ${containerDir} (leftover swept, compose workspace up)`,
      async () => {
        const ids = await dockerPsByLabelFolder(containerDir);
        ctx.expect(
          `docker ps -aq for ${containerDir} has exactly one container`,
          ids.length === 1,
          `docker ps -aq returned: ${JSON.stringify(ids)}`,
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
 * `devcontainer.local_folder=<dir>` label — the anchor
 * `@devcontainers/cli` writes on every container regardless of
 * image-mode vs compose-mode. Throws on docker failure rather than
 * returning `[]` silently, so the assertion can't go green on a broken
 * setup.
 */
async function dockerPsByLabelFolder(containerDir: string): Promise<string[]> {
  const result = await runDocker([
    'ps',
    '-aq',
    '--filter',
    `label=devcontainer.local_folder=${containerDir}`,
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

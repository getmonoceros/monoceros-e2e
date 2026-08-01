import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Helpers for temporarily steering the machine-global
 * `monoceros-config.yml` during a scenario - currently just
 * `routing.hostPort`, which is the only place a scenario needs to
 * override builder-global state.
 *
 * Why snapshot-and-restore instead of "reset to 80": the e2e tool runs
 * on a real builder machine whose `monoceros-config.yml` may already
 * carry an intentional `hostPort` (or other defaults). Hard-resetting
 * to the default would silently clobber it. Scenarios run sequentially,
 * so restoring the exact prior content (including "the file did not
 * exist") at the end is both sufficient and safe.
 */

function monocerosHome(): string {
  return (
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    )
  );
}

function configPath(): string {
  return path.join(monocerosHome(), 'monoceros-config.yml');
}

/**
 * Set `routing.hostPort` in the global config and return a `restore()`
 * that puts the file back exactly as it was - its previous content, or
 * removed again if it didn't exist before. Call `restore()` in a
 * `finally` so a mid-scenario failure can't leave the port redirected
 * for the rest of the suite.
 */
export async function withGlobalHostPort(
  port: number,
): Promise<() => Promise<void>> {
  const file = configPath();
  let original: string | null = null;
  try {
    original = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `schemaVersion: 1\nrouting:\n  hostPort: ${port}\n`,
    'utf8',
  );
  return async () => {
    if (original === null) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, original, 'utf8');
    }
  };
}

/**
 * Set `defaults.git.user` in the global config and return a `restore()`
 * with the same contract as {@link withGlobalHostPort}.
 *
 * Why a scenario needs this: a CI runner has no `git config --global`
 * identity, so a container applied there gets none either, and
 * `monoceros check` correctly reports a workbench that cannot commit.
 * A real builder machine almost always has one, so hard-coding an
 * identity here is what makes the run resemble a builder's, rather than
 * a workaround for the finding.
 */
export async function withGlobalGitUser(user: {
  name: string;
  email: string;
}): Promise<() => Promise<void>> {
  const file = configPath();
  let original: string | null = null;
  try {
    original = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      'schemaVersion: 1',
      'defaults:',
      '  git:',
      '    user:',
      `      name: ${user.name}`,
      `      email: ${user.email}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return async () => {
    if (original === null) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, original, 'utf8');
    }
  };
}

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Helpers for temporarily steering the machine-global settings in
 * `monoceros-config.env` during a scenario: the proxy host port and the
 * git identity, the only builder-global state a scenario needs to
 * override. (The machine-wide `monoceros-config.yml` is retired, workbench
 * ADR 0061.)
 *
 * Why snapshot-and-restore instead of "reset to the default": the e2e tool
 * runs on a real builder machine whose env file carries real tokens and may
 * already carry an intentional port or identity. Scenarios run sequentially,
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

/**
 * Set `vars` in the global env and return a `restore()` that puts the file
 * back exactly as it was. Every other line stays: that file holds the
 * builder's real `GIT_TOKEN__*` values on a dev machine, and a scenario has
 * no business dropping them for the length of its run. Call `restore()` in a
 * `finally` so a mid-scenario failure cannot leave the setting behind.
 */
async function withGlobalEnv(
  vars: Record<string, string>,
): Promise<() => Promise<void>> {
  const file = path.join(monocerosHome(), 'monoceros-config.env');
  let original: string | null = null;
  try {
    original = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const kept = (original ?? '')
    .split('\n')
    .filter((line) => {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(
        line,
      )?.[1];
      return key === undefined || !(key in vars);
    })
    .join('\n');
  const prefix = kept === '' || kept.endsWith('\n') ? '' : '\n';
  const added = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${kept}${prefix}${added}`, 'utf8');
  return async () => {
    if (original === null) {
      await fs.rm(file, { force: true });
    } else {
      await fs.writeFile(file, original, 'utf8');
    }
  };
}

/** Set `MONOCEROS_HOST_PORT`; see {@link withGlobalEnv} for the contract. */
export function withGlobalHostPort(port: number): Promise<() => Promise<void>> {
  return withGlobalEnv({ MONOCEROS_HOST_PORT: String(port) });
}

/**
 * Set `GIT_USER_NAME` / `GIT_USER_EMAIL`; see {@link withGlobalEnv}.
 *
 * Why a scenario needs this: a CI runner has no `git config --global`
 * identity, so a container applied there gets none either, and a commit
 * inside it fails. A real builder machine almost always has one, so setting
 * an identity here is what makes the run resemble a builder's.
 */
export function withGlobalEnvGitUser(user: {
  name: string;
  email: string;
}): Promise<() => Promise<void>> {
  return withGlobalEnv({
    GIT_USER_NAME: user.name,
    GIT_USER_EMAIL: user.email,
  });
}

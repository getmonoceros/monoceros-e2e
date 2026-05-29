import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { E2E_DOCKER_NAME_FILTER, E2E_PREFIX } from './naming.js';
import { run } from './cli.js';

/**
 * Pre-flight cleanup. Runs BEFORE every scenario start (and before
 * `--all` does its first scenario). Purpose: any e2e-* container or
 * yml-Profil that's hanging around from a previous run — interrupted
 * by Ctrl+C, crashed, or just left with `--keep` — gets removed so we
 * start from a clean slate.
 *
 * Two passes:
 *
 *   1. Iterate `$MONOCEROS_HOME/container-configs/e2e-*.yml`, remove
 *      each via `monoceros remove --no-backup --yes <name>`. This is
 *      the well-behaved path: monoceros knows about the container, it
 *      tears down compose stacks, docker containers and the yml in one
 *      go.
 *
 *   2. As a safety net for orphans (yml already gone, container still
 *      lingering — e.g. someone hand-deleted the yml file):
 *      `docker ps -aq --filter "name=^e2e-"` → `docker rm -f`. This
 *      doesn't touch yml or other state, just kills runaway containers.
 *
 * Either pass failing softly (warns, doesn't abort) — cleanup is
 * preparation, not the test itself. The scenario will fail loudly if
 * the env is still dirty.
 */

export interface CleanupOptions {
  monocerosHome?: string;
  log?: (line: string) => void;
}

export async function preflightCleanup(
  opts: CleanupOptions = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const home = opts.monocerosHome ?? resolveMonocerosHome();

  const removed = await removeKnownYmls(home, log);
  const killed = await killOrphanContainers(log);

  if (removed === 0 && killed === 0) {
    log('Pre-flight cleanup: nothing to clean.');
  } else {
    log(
      `Pre-flight cleanup: removed ${removed} container-config(s), force-killed ${killed} orphan(s).`,
    );
  }
}

/** Best-effort resolution mirroring the workbench: env var → `~/.monoceros`. */
function resolveMonocerosHome(): string {
  const env = process.env.MONOCEROS_HOME?.trim();
  if (env) return env;
  return path.join(homeDir(), '.monoceros');
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}

async function removeKnownYmls(
  home: string,
  log: (m: string) => void,
): Promise<number> {
  const dir = path.join(home, 'container-configs');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    log(`Pre-flight: could not read ${dir}: ${(err as Error).message}`);
    return 0;
  }
  const ymls = entries.filter(
    (e) => e.startsWith(E2E_PREFIX) && e.endsWith('.yml'),
  );
  if (ymls.length === 0) return 0;

  let removed = 0;
  for (const yml of ymls) {
    const name = yml.replace(/\.yml$/, '');
    try {
      await run(['remove', name, '--no-backup', '--yes'], {
        allowNonZero: true,
      });
      removed++;
    } catch (err) {
      log(
        `Pre-flight: \`monoceros remove ${name}\` failed: ${(err as Error).message}`,
      );
    }
  }
  return removed;
}

async function killOrphanContainers(log: (m: string) => void): Promise<number> {
  const ids = await dockerPsByName(E2E_DOCKER_NAME_FILTER, log);
  if (ids.length === 0) return 0;
  await dockerRmForce(ids, log);
  return ids.length;
}

function dockerPsByName(
  filter: string,
  log: (m: string) => void,
): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['ps', '-aq', '--filter', `name=${filter}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      log(`Pre-flight: docker ps failed: ${err.message}`);
      resolve([]);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        log(`Pre-flight: docker ps exited with ${code}: ${stderr.trim()}`);
        resolve([]);
        return;
      }
      resolve(
        stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
    });
  });
}

function dockerRmForce(ids: string[], log: (m: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', ...ids], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      log(`Pre-flight: docker rm -f failed: ${err.message}`);
      resolve();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        log(`Pre-flight: docker rm -f exited with ${code}: ${stderr.trim()}`);
      }
      resolve();
    });
  });
}

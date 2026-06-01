import { spawn } from 'node:child_process';

/**
 * Thin docker-CLI wrapper with the same Linux docker-group recovery
 * that the workbench itself does (see
 * packages/cli/src/devcontainer/docker-group-bootstrap.ts in the
 * workbench repo).
 *
 * Why this exists: on a fresh Linux install after `install.sh` has
 * added the user to the `docker` group, the user's CURRENT shell
 * session still doesn't have the docker GID in its credentials —
 * the group change only takes effect on the next login (or after
 * `newgrp docker`). Monoceros sidesteps that by re-exec'ing itself
 * via `sg docker -c "node …"` when it detects EACCES on the docker
 * socket and the user IS in /etc/group's docker line.
 *
 * The e2e tool needs the same trick because it shells out to docker
 * directly (e.g. for the `image-mode-zombie` regression assert,
 * which queries `docker ps` with a label filter). Without this
 * wrapper, the scenario would silently fail on a freshly-installed
 * Linux box even when monoceros itself runs fine.
 */

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PERMISSION_DENIED_RE =
  /permission denied while trying to connect to the docker/i;

export async function runDocker(args: string[]): Promise<DockerResult> {
  const direct = await spawnRaw('docker', args);
  if (
    direct.exitCode !== 0 &&
    process.platform === 'linux' &&
    PERMISSION_DENIED_RE.test(direct.stderr)
  ) {
    // Retry via `sg docker -c "docker …"`. sg runs the command with
    // the docker group's GID active, which is exactly what `newgrp
    // docker` would do for the rest of the session.
    return spawnRaw('sg', ['docker', '-c', joinShellArgs(['docker', ...args])]);
  }
  return direct;
}

function spawnRaw(bin: string, args: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) =>
      resolve({ exitCode: 1, stdout, stderr: err.message }),
    );
    child.on('exit', (code) =>
      resolve({ exitCode: code ?? 0, stdout, stderr }),
    );
  });
}

/** Shell-escape an argv into a single string for `sg -c`. */
function joinShellArgs(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Normalize a host filesystem path into the form @devcontainers/cli
 * stamps in the `devcontainer.local_folder` Docker label. On Windows
 * the cli lowercases the drive letter (`C:\…` → `c:\…`) before
 * writing it, and Docker `--filter label=…=<value>` does a byte-exact
 * match — feeding it our untouched path.join-built `C:\…` silently
 * misses every container.
 *
 * Mirrors the helper of the same name in the workbench
 * (packages/cli/src/devcontainer/compose.ts). Duplicated here on
 * purpose: e2e imports nothing from the workbench package by design
 * (see e2e CLAUDE.md → „Was bewusst nicht als Dependency drin ist").
 *
 * No-op off Windows.
 */
export function dockerLocalFolderLabel(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(
    /^([A-Z]):/,
    (_, drive: string) => `${drive.toLowerCase()}:`,
  );
}

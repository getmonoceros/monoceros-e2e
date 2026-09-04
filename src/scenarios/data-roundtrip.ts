import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runDocker } from '../lib/docker.js';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * Same throw-away image the workbench's own remove/backup fallbacks use, so
 * reading a backup needs no image this suite does not already pull.
 */
const COPY_IMAGE = 'alpine:3.21';

/**
 * `data-roundtrip` — Service-Daten überleben den ganzen Lebenszyklus.
 *
 * Seit ADR 0036 liegen Service-Daten in einem Docker-Volume
 * (`monoceros-<name>-data-<svc>`) statt in einem Host-Bind-Mount. Dass ein
 * frischer Postgres hochkommt, prüft `with-services`. Was kein Szenario
 * geprüft hat: dass die Daten den Lebenszyklus überleben — und das ist
 * genau der Teil, den 0036 umgebaut hat.
 *
 * Lifecycle:
 *   1. `init --with-services=postgres` + `apply`, dann warten bis postgres
 *      wirklich antwortet - jeder `apply` und jeder `restore` braucht diesen
 *      Wait, siehe {@link waitForPostgres}.
 *   2. Zeile schreiben (psql aus dem Workspace, Credentials aus `$POSTGRES_URL`).
 *   3. `apply` nochmal — die Zeile ist noch da, das Volume wird also nicht
 *      neu angelegt.
 *   4. `remove` MIT Backup (Default) — das Backup trägt die Daten als
 *      normale Dateien unter `container/data/postgres/`, nicht leer.
 *   5. `restore` + `apply` — die Zeile ist wieder live.
 *
 * Plattform-Grenze, bewusst benannt: der Bug, der zu 0036 geführt hat, war
 * Docker-Desktop-spezifisch (VirtioFS reicht den chown des Entrypoints nicht
 * an den Host durch). Auf einem Linux-Runner wäre er nie aufgetreten. Dieses
 * Szenario schützt die Migration und den Backup-Pfad, die
 * plattformunabhängig sind, nicht das Ownership-Verhalten selbst.
 */
export const dataRoundtrip: Scenario = {
  id: 'data-roundtrip',
  description:
    'apply → write row → re-apply (row survives) → remove+backup (data in backup) → restore → apply (row live again)',
  estimatedSeconds: 320,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-services=postgres`, () =>
      ctx.cli([
        'init',
        ctx.name,
        '--with-languages=node',
        '--with-services=postgres',
      ]),
    );

    await ctx.step(`apply ${ctx.name}`, () => ctx.cli(['apply', ctx.name]));

    await ctx.step('postgres accepts connections', () => waitForPostgres(ctx));

    await ctx.step('write a row into postgres', () =>
      psql(
        ctx,
        "create table survives(note text); insert into survives values ('before the re-apply');",
        'write',
      ),
    );

    await ctx.step(
      `apply ${ctx.name} again — the volume is not recreated`,
      () => ctx.cli(['apply', ctx.name]),
    );

    await ctx.step('the row survived the re-apply', () =>
      expectRow(ctx, 'after re-apply'),
    );

    const backup = await ctx.step(
      `remove ${ctx.name} (with backup) — data lands in the backup`,
      () => removeWithBackup(ctx),
    );

    await ctx.step(`restore ${backup}`, () => ctx.cli(['restore', backup]));

    await ctx.step(`apply ${ctx.name} — seeds the volume from the backup`, () =>
      ctx.cli(['apply', ctx.name]),
    );

    await ctx.step('the row is live again', () =>
      expectRow(ctx, 'after restore'),
    );

    await ctx.step('clean up the backup this scenario wrote', () =>
      removeBackup(ctx, backup),
    );
  },
};

/**
 * Wait until postgres answers a query. Needed before EVERY statement this
 * scenario runs, not only before the first write.
 *
 * `apply` returns when the containers are up, which is not when the database
 * serves: postgres needs a few seconds, and on a slow runner more. Without
 * this the scenario raced the database and lost at random - and a lost race
 * reads exactly like a product bug, in a suite that gates every release.
 *
 * The re-apply and the restore need it just as much, which is what the
 * nightly run of 2026-09-04 collected: `apply` force-removes the existing
 * containers (`docker rm -f`, so SIGKILL), postgres comes back up in crash
 * recovery, and the read fired 100ms later got `FATAL: the database system
 * is not yet accepting connections / Consistent recovery state has not been
 * yet reached`. That window is longer than a cold start's, so a read after
 * an `apply` is the likelier loser of the two. Hence the wait sits in
 * {@link expectRow} rather than at one call site.
 *
 * Retried INSIDE the workspace so 30 attempts cost one `monoceros run`
 * invocation, the same shape `with-services` uses for its TCP probe. It
 * queries rather than checking the port, because postgres accepts a
 * connection a moment before it will run a statement ("the database system is
 * starting up").
 */
async function waitForPostgres(ctx: ScenarioCtx): Promise<void> {
  const script =
    'for i in $(seq 1 30); do ' +
    'psql "$POSTGRES_URL" -tAc "select 1" >/dev/null 2>&1 && echo ready && exit 0; ' +
    'sleep 1; done; echo timeout; exit 1';
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    'postgres answers `select 1` within 30s',
    result.exitCode === 0 && result.stdout.trim().endsWith('ready'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

/** Run one SQL statement through psql in the workspace. */
async function psql(
  ctx: ScenarioCtx,
  sql: string,
  label: string,
): Promise<{ stdout: string }> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `psql "$POSTGRES_URL" -tAc ${JSON.stringify(sql)}`,
  ]);
  ctx.expect(
    `psql (${label}) exits 0`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
  return { stdout: result.stdout };
}

async function expectRow(ctx: ScenarioCtx, label: string): Promise<void> {
  await waitForPostgres(ctx);
  const { stdout } = await psql(ctx, 'select note from survives;', label);
  ctx.expect(
    `the row is there ${label}`,
    stdout.includes('before the re-apply'),
    `psql stdout: ${JSON.stringify(stdout.trim().slice(-200))}`,
  );
}

/**
 * `remove` with the default backup, then assert the backup really carries the
 * data. The backup path is read off the filesystem, not parsed out of the
 * output: the newest `container-backups/<name>-*` directory is unambiguous
 * because the name carries a timestamp and the container name.
 */
async function removeWithBackup(ctx: ScenarioCtx): Promise<string> {
  await ctx.cli(['remove', ctx.name, '--yes']);

  const backupsDir = path.join(monocerosHome(), 'container-backups');
  const entries = await fs.readdir(backupsDir).catch(() => []);
  const mine = entries.filter((e) => e.startsWith(`${ctx.name}-`)).sort();
  ctx.expect(
    'remove wrote a backup directory',
    mine.length > 0,
    `no ${ctx.name}-* in ${backupsDir}`,
  );
  const backup = path.join(backupsDir, mine[mine.length - 1]!);

  const dataDir = path.join(backup, 'container', 'data', 'postgres');
  const cluster = await findFileAsRoot(dataDir, 'PG_VERSION');
  ctx.expect(
    'the backup carries the postgres cluster as plain files',
    cluster !== null,
    `no PG_VERSION under ${dataDir}`,
  );
  ctx.info(`backup at ${backup}, cluster file ${cluster ?? '<none>'}`);
  return backup;
}

/**
 * Delete the backup this scenario produced, root-owned parts included.
 *
 * `fs.rm` cannot: the cluster directory copied out of the volume is
 * `drwx------` owned by uid 999, so the host-side recursive delete gets
 * EACCES on `data/postgres/<version>/<dir>` — the same wall the read side
 * hits. So the removal runs as root in a throw-away container, with the
 * backup's PARENT mounted so the top-level directory goes too.
 *
 * Cleanup, not an assertion: a leftover backup directory costs disk on the
 * runner, it does not invalidate the run. A failure is reported and the
 * scenario still passes.
 */
async function removeBackup(ctx: ScenarioCtx, backup: string): Promise<void> {
  const parent = path.dirname(backup);
  const leaf = path.basename(backup);
  const { exitCode, stderr } = await runDocker([
    'run',
    '--rm',
    '-v',
    `${parent}:/backups`,
    COPY_IMAGE,
    'rm',
    '-rf',
    `/backups/${leaf}`,
  ]);
  if (exitCode !== 0) {
    ctx.info(
      `could not remove ${backup} (docker rm exit ${exitCode}${
        stderr.trim() ? `: ${stderr.trim()}` : ''
      }); left it in place`,
    );
    return;
  }
  ctx.info(`removed ${backup}`);
}

/**
 * Depth-first search for a file by name, run as root inside a throw-away
 * container. Returns the path relative to `dir`, or null.
 *
 * Why not `fs.readdir` from the host: a Postgres cluster directory is
 * `drwx------` owned by uid 999, and `remove` copies the data volume with
 * `cp -a`, which preserves that. On Linux the backup tree therefore belongs
 * to postgres and the user running the e2e tool cannot even list it — the
 * host-side walk gets EACCES and reports "no data" for a backup that is
 * perfectly fine. It only looked correct on macOS, where Docker Desktop's
 * VirtioFS does not pass the ownership through to the host (the same
 * platform asymmetry this scenario's header calls out).
 *
 * So the backup is read with the same eyes that wrote it: root, inside a
 * container, exactly as `remove` does for its own EACCES fallback.
 */
async function findFileAsRoot(
  dir: string,
  name: string,
): Promise<string | null> {
  const { exitCode, stdout, stderr } = await runDocker([
    'run',
    '--rm',
    '-v',
    `${dir}:/backup:ro`,
    COPY_IMAGE,
    'find',
    '/backup',
    '-name',
    name,
    '-type',
    'f',
  ]);
  if (exitCode !== 0) {
    // A missing bind source (the directory was never written) is the
    // interesting failure, and it reads as "not found" here. Anything
    // else — no docker, no image — would be a broken harness, so it is
    // worth seeing in the output rather than being swallowed.
    if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
    return null;
  }
  const hit = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return hit ?? null;
}

function monocerosHome(): string {
  return (
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    )
  );
}

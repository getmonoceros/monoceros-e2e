import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

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
 *   1. `init --with-services=postgres` + `apply`.
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

    await ctx.step('clean up the backup this scenario wrote', async () => {
      await fs.rm(backup, { recursive: true, force: true });
      ctx.info(`removed ${backup}`);
    });
  },
};

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
  const cluster = await findFile(dataDir, 'PG_VERSION');
  ctx.expect(
    'the backup carries the postgres cluster as plain files',
    cluster !== null,
    `no PG_VERSION under ${dataDir}`,
  );
  ctx.info(`backup at ${backup}, cluster file ${cluster ?? '<none>'}`);
  return backup;
}

/** Depth-first search for a file by name; returns its path or null. */
async function findFile(dir: string, name: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    }
  }
  return null;
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

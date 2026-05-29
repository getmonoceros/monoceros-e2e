import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';

/**
 * `with-services` — Compose-Mode mit einem Postgres-Service-Container,
 * inkl. echtem CRUD-Roundtrip vom Workspace aus.
 *
 * Lifecycle:
 *   1. `monoceros init --with=node,postgres
 *      --with-repo=…/monoceros-e2e-fixture` — Compose-Profil + Repo.
 *   2. `monoceros apply` — workspace + postgres hochfahren, Fixture
 *      landet unter projects/.
 *   3. **TCP-Probe** auf `postgres:5432` aus dem Workspace, mit
 *      30s-Retry-Loop in Bash. Fail-fast-Baseline — wenn der Port
 *      nicht aufgeht, sparen wir uns den teureren Pfad.
 *   4. `npm ci` für die Fixture-Deps (heute: pg).
 *   5. **db-client-Probe**: `node db-client.mjs` — connect, CREATE
 *      TEMP TABLE, INSERT 2, SELECT + verify, DELETE 1, count-check.
 *      Erwartet `ok` als letzte stdout-Zeile.
 *   6. `remove` räumt Compose-Stack, Daten-Mount, yml weg.
 *
 * Was es prüft (in dieser Reihenfolge):
 *   - Compose-Default-Netzwerk + DNS-Auflösung (TCP-Probe)
 *   - npm-install-Pfad in einem geclonten Repo
 *   - Postgres-Wire-Protokoll + Service-Credentials aus dem Catalog
 *   - Self-cleaning TEMP-Tabelle (kein Persistenz-Setup nötig)
 */
export const withServices: Scenario = {
  id: 'with-services',
  description:
    'init → apply → TCP-probe + postgres CRUD via pg → remove (Compose-Mode, postgres-Service, fixture-Repo)',
  estimatedSeconds: 150,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with=node,postgres --with-repo=…/monoceros-e2e-fixture`,
      async () => {
        await ctx.cli([
          'init',
          ctx.name,
          '--with=node,postgres',
          `--with-repo=${FIXTURE_REPO}`,
        ]);
      },
    );

    await ctx.step(`apply ${ctx.name}`, async () => {
      await ctx.cli(['apply', ctx.name, '--yes']);
    });

    await ctx.step(`workspace can reach postgres:5432 via DNS`, () =>
      probeTcpFromWorkspace(ctx, 'postgres', 5432),
    );

    await ctx.step(`install fixture deps (npm ci in ${FIXTURE_DIR})`, () =>
      installFixtureDeps(ctx),
    );

    await ctx.step(`db-client CRUD roundtrip against postgres`, () =>
      runDbClient(ctx),
    );
  },
};

/**
 * Bash retry loop INSIDE the workspace, one `monoceros run` invocation
 * regardless of retries. 30 attempts × 1s — comfortable headroom for
 * postgres's 5–15s typical startup, without burning devcontainer-cli
 * spawn overhead per attempt.
 */
async function probeTcpFromWorkspace(
  ctx: ScenarioCtx,
  host: string,
  port: number,
): Promise<void> {
  const script = `for i in $(seq 1 30); do </dev/tcp/${host}/${port} && echo ok && exit 0; sleep 1; done; echo timeout; exit 1`;
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    `\`${host}:${port}\` reachable from workspace within 30s`,
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

async function installFixtureDeps(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && npm ci --no-audit --no-fund`,
  ]);
  ctx.expect(
    'npm ci succeeded',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
}

async function runDbClient(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && node db-client.mjs`,
  ]);
  const tail = result.stdout.trim().split('\n').slice(-1)[0] ?? '';
  ctx.expect(
    'db-client exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
  ctx.expect(
    'db-client stdout ends with `ok`',
    tail === 'ok',
    `last line: ${JSON.stringify(tail)}`,
  );
  ctx.info(
    'db-client CRUD roundtrip ok — connect, CREATE/INSERT/SELECT/DELETE.',
  );
}

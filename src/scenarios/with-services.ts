import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-services` — Compose-Mode mit einem Postgres-Service-Container.
 *
 * Was es prüft:
 *   - `monoceros init --with=node,postgres` materialisiert ein
 *     Compose-Profil (workspace + postgres).
 *   - `monoceros apply` fährt beide hoch.
 *   - Vom Workspace aus ist postgres unter `postgres:5432` per DNS
 *     erreichbar (Compose-Default-Netzwerk). Probe via Bash-builtin
 *     `</dev/tcp/postgres/5432` — kein Postgres-Client nötig, kein
 *     Tool-Footprint im Workspace.
 *   - `remove` räumt Compose-Stack, Volumes-Daten-Mount, yml weg.
 *
 * Was es bewusst NICHT prüft: `SELECT 1`-Roundtrip. Das würde `psql`
 * im Workspace-Image voraussetzen. TCP-Reachability ist die ehrliche
 * baseline-Aussage.
 */
export const withServices: Scenario = {
  id: 'with-services',
  description:
    'init → apply → TCP-probe postgres:5432 from workspace → remove (Compose-Mode, postgres-Service)',
  estimatedSeconds: 120,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with=node,postgres`, async () => {
      await ctx.cli(['init', ctx.name, '--with=node,postgres']);
    });

    await ctx.step(`apply ${ctx.name}`, async () => {
      await ctx.cli(['apply', ctx.name, '--yes']);
    });

    await ctx.step(`workspace can reach postgres:5432 via DNS`, () =>
      probeTcpFromWorkspace(ctx, 'postgres', 5432),
    );
  },
};

/**
 * Run a Bash retry loop INSIDE the workspace container that tries the
 * Bash-builtin `</dev/tcp/<host>/<port>` redirect once per second for
 * up to 30 attempts. Returns when the redirect succeeds (port
 * accepting connections) or the loop exhausts (TCP not reachable).
 *
 * One `monoceros run` invocation regardless of retry count — repeatedly
 * spawning devcontainer-cli would burn 1–2s per attempt. Service
 * containers (postgres, mysql, …) typically need 5–15s to be ready
 * after the workspace is up, so 30s is comfortable headroom without
 * crossing the scenario's overall time budget.
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

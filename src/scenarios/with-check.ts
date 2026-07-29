import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-check` — `monoceros check` (workbench ADR 0040), the host-side
 * report on the briefing rules an agent did not follow.
 *
 * Unit tests in the workbench already cover each rule against a
 * hand-built directory tree. What they cannot cover, and this scenario
 * does:
 *
 *   - A **real** `apply` produces a workbench the check calls clean. If
 *     the scaffold ever writes something at the workspace root that the
 *     check does not know about, or stops registering a cloned repo, the
 *     command would cry wolf on a fresh container — and nobody would
 *     trust it again.
 *   - The findings come from work done **inside** the container, the way
 *     an agent produces them: a project scaffolded and never registered,
 *     a compose file with a postgres block written from memory.
 *   - The exit code: 0 when clean, 1 when there are findings, so a
 *     pipeline can act on it.
 *
 * Lifecycle:
 *   1. `init` (node, postgres, one port) → `apply`.
 *   2. `check` on the untouched container: exit 0, nothing to report.
 *   3. In the container: scaffold `projects/shop` with a `dev` script and
 *      a compose file whose postgres block drifts from the catalog.
 *   4. `check` again: exit 1, with the workspace-registration, the
 *      compose-drift and the launch-config findings.
 *
 * Deliberately NOT covered: the rules that cannot be checked (repo
 * language, service config written from memory). They are the reason the
 * briefing states its rules up front, not something a command can prove.
 */
export const withCheck: Scenario = {
  id: 'with-check',
  description:
    'check: a freshly applied workbench reports clean (exit 0), an unregistered project + drifted compose block report findings (exit 1)',
  estimatedSeconds: 140,
  async run(ctx) {
    const name = ctx.name;

    await ctx.step(`init ${name} (node, postgres, port 3000)`, () =>
      ctx.cli([
        'init',
        name,
        '--with-languages=node',
        '--with-services=postgres',
        '--with-ports=3000',
      ]),
    );

    await ctx.step(`apply ${name}`, () => ctx.cli(['apply', name, '--yes']));

    await ctx.step(`check ${name} reports a clean workbench`, () =>
      assertClean(ctx),
    );

    await ctx.step(
      `agent-style work in the container: unregistered project + drifted compose`,
      () => makeFindings(ctx),
    );

    await ctx.step(`check ${name} reports every finding and exits 1`, () =>
      assertFindings(ctx),
    );
  },
};

async function assertClean(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture(['check', ctx.name]);
  ctx.expect(
    'check exits 0 on a freshly applied workbench',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
  ctx.expect(
    'check says there is nothing to report',
    result.stdout.includes('Nothing to report.'),
    `stdout was: ${result.stdout.trim()}`,
  );
}

/**
 * Produce, from inside the container, exactly the mistakes the live test
 * produced: a project directory that never reaches the workspace file,
 * carrying a `dev` script but no launch config, plus a compose file whose
 * postgres block has the wrong tag, no healthcheck and a hardcoded
 * password.
 */
async function makeFindings(ctx: ScenarioCtx): Promise<void> {
  const shop = `/workspaces/${ctx.name}/projects/shop`;
  const compose = [
    'services:',
    '  postgres:',
    '    image: postgres:15',
    '    environment:',
    '      POSTGRES_USER: shop',
    '      POSTGRES_PASSWORD: shop',
    '      POSTGRES_DB: shop',
  ].join('\n');
  const script = [
    `mkdir -p ${shop}`,
    `printf '%s' '{"name":"shop","scripts":{"dev":"vite"}}' > ${shop}/package.json`,
    // `%b`, not `%s`: the JSON string carries `\n` as an escape, and only
    // `%b` expands those. With `%s` the whole compose file lands on one
    // line and the check reports unparseable YAML instead of the drift.
    `printf '%b\\n' ${JSON.stringify(compose)} > ${shop}/compose.yaml`,
    `echo ok`,
  ].join(' && ');
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    'the container-side scaffold succeeded',
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
}

async function assertFindings(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture(['check', ctx.name]);
  const out = result.stdout;
  ctx.expect(
    'check exits 1 when it found something',
    result.exitCode === 1,
    `exit ${result.exitCode}: ${out.trim()} / ${result.stderr.trim()}`,
  );
  ctx.expect(
    'the unregistered project is reported',
    out.includes('Workspace registration') && out.includes('projects/shop'),
    `stdout was: ${out.trim()}`,
  );
  ctx.expect(
    'the workspace-registration fix names the folders entry to add',
    out.includes('"path": "projects/shop"'),
    `stdout was: ${out.trim()}`,
  );
  // Guard on the fixture itself: a compose file written wrong would be
  // reported as unparseable, and every drift assertion below would fail
  // for a reason that has nothing to do with the check.
  ctx.expect(
    'the fixture compose file is valid YAML',
    !out.includes('Not parseable as YAML'),
    `stdout was: ${out.trim()}`,
  );
  ctx.expect(
    'the drifted image tag is reported against the catalog block',
    out.includes('Compose drift') && out.includes('postgres:15'),
    `stdout was: ${out.trim()}`,
  );
  ctx.expect(
    'the missing healthcheck is reported',
    out.includes('No healthcheck'),
    `stdout was: ${out.trim()}`,
  );
  ctx.expect(
    'the hardcoded password is reported instead of a required variable',
    out.includes('POSTGRES_PASSWORD'),
    `stdout was: ${out.trim()}`,
  );
  ctx.expect(
    'the project that serves something without a launch config is reported',
    out.includes('Launch config') && out.includes('`dev` script'),
    `stdout was: ${out.trim()}`,
  );
}

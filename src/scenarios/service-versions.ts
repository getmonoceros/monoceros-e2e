import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `service-versions` — a builder's own service in two versions
 * (workbench ADR 0066, #139).
 *
 * What it proves, with the installed CLI and real containers:
 *   - `init --with-services=e2e-cache` writes `ref: e2e-cache@1` under the
 *     service, and `apply` puts version 1's briefing into AGENTS.md
 *   - with version 2 next to it, `upgrade` merges version 2 into the yml
 *     (`ref: e2e-cache@2`, the new healthcheck interval) and the briefing
 *     in AGENTS.md follows
 *   - with the descriptor files gone, `apply` still succeeds, names the
 *     missing file, and leaves the briefing out
 *
 * The three-way merge itself (builder edits, conflicts, `--replace`) is
 * covered by the workbench unit tests; this scenario proves the chain.
 *
 * The descriptor files are written into `$MONOCEROS_HOME/templates/services/`
 * and removed again at the end, whatever happened in between.
 */
export const serviceVersions: Scenario = {
  id: 'service-versions',
  description:
    'own service v1 → init + apply (ref @1, v1 briefing) → add v2 → upgrade (ref @2, merged, v2 briefing) → files gone → apply still succeeds with a hint',
  estimatedSeconds: 200,
  async run(ctx) {
    const services = path.join(home(), 'templates', 'services');
    const current = path.join(services, 'e2e-cache.yml');
    const older = path.join(services, 'e2e-cache@1.yml');
    try {
      await ctx.step('write the own service e2e-cache, version 1', async () => {
        mkdirSync(services, { recursive: true });
        writeFileSync(current, descriptor(1), 'utf8');
      });

      await ctx.step(`init ${ctx.name} --with-services=e2e-cache`, async () => {
        const r = await ctx.cliCapture([
          'init',
          ctx.name,
          '--with-services=e2e-cache',
        ]);
        ctx.expect('init exits 0', r.exitCode === 0, r.stderr.trim());
        ctx.expect(
          'the yml records ref: e2e-cache@1',
          /^\s+ref: e2e-cache@1$/m.test(readYml(ctx)),
          'no ref line for version 1',
        );
      });

      await ctx.step(`apply ${ctx.name}`, async () => {
        const code = await ctx.cli(['apply', ctx.name, '--yes']);
        ctx.expect('apply exits 0', code === 0, `exit ${code}`);
        ctx.expect(
          "AGENTS.md carries version 1's briefing",
          readAgents(ctx).includes(BRIEFING(1)),
          'version 1 briefing not found',
        );
      });

      await ctx.step(
        'add version 2, keep version 1 as e2e-cache@1.yml',
        async () => {
          writeFileSync(older, readFileSync(current, 'utf8'), 'utf8');
          writeFileSync(current, descriptor(2), 'utf8');
        },
      );

      await ctx.step(`upgrade ${ctx.name} (runtime kept)`, async () => {
        // Pin the runtime the yml already has, so only the service moves.
        const runtime = /^runtimeVersion: (\S+)$/m.exec(readYml(ctx))?.[1];
        ctx.expect('the yml pins a runtime', runtime, 'no runtimeVersion');
        const r = await ctx.cliCapture(['upgrade', ctx.name, runtime!]);
        ctx.expect('upgrade exits 0', r.exitCode === 0, r.stderr.trim());
        ctx.expect(
          'upgrade reports the service upgraded from 1 to 2',
          /Upgraded e2e-cache in '[^']+': e2e-cache 1 → 2/.test(r.stdout),
          `stdout: ${r.stdout.trim()}`,
        );
        const yml = readYml(ctx);
        ctx.expect(
          'the yml records ref: e2e-cache@2',
          /^\s+ref: e2e-cache@2$/m.test(yml),
          'ref was not moved to version 2',
        );
        ctx.expect(
          "the yml carries version 2's healthcheck interval",
          /^\s+interval: 5s$/m.test(yml),
          'interval 5s not found',
        );
        ctx.expect(
          "AGENTS.md carries version 2's briefing",
          readAgents(ctx).includes(BRIEFING(2)),
          'version 2 briefing not found',
        );
      });

      await ctx.step('take the descriptor files away', async () => {
        rmSync(current, { force: true });
        rmSync(older, { force: true });
      });

      await ctx.step(`apply ${ctx.name} without the files`, async () => {
        const r = await ctx.cliCapture(['apply', ctx.name, '--yes']);
        ctx.expect(
          'apply still exits 0',
          r.exitCode === 0,
          `exit ${r.exitCode}: ${r.stderr.trim()}`,
        );
        ctx.expect(
          'apply names the missing file',
          `${r.stdout}\n${r.stderr}`.includes('e2e-cache.yml is not here'),
          `stdout: ${r.stdout.trim()}\nstderr: ${r.stderr.trim()}`,
        );
        ctx.expect(
          'AGENTS.md has no briefing for it',
          !readAgents(ctx).includes('e2e-cache version'),
          'a briefing line is still there',
        );
      });
    } finally {
      rmSync(current, { force: true });
      rmSync(older, { force: true });
    }
  },
};

const BRIEFING = (version: number): string =>
  `The e2e-cache version ${version} answers at $E2E_CACHE_URL.`;

/** The own service in a given version; version 2 checks its health more often. */
function descriptor(version: number): string {
  return [
    'id: e2e-cache',
    'category: service',
    `version: ${version}`,
    'displayName: E2E cache',
    `description: 'Redis kept as an own service, version ${version}.'`,
    'service:',
    '  image: redis:8',
    '  defaultPort: 6379',
    '  healthcheck:',
    '    test: [CMD, redis-cli, ping]',
    `    interval: ${version === 1 ? '10s' : '5s'}`,
    '    retries: 5',
    '  connectionEnv:',
    '    URL: redis://${host}:${port}',
    'briefing:',
    `  - text: '${BRIEFING(version)}'`,
    '',
  ].join('\n');
}

function home(): string {
  return (
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    )
  );
}

function readYml(ctx: ScenarioCtx): string {
  return readFileSync(
    path.join(home(), 'container-configs', `${ctx.name}.yml`),
    'utf8',
  );
}

function readAgents(ctx: ScenarioCtx): string {
  const file = path.join(home(), 'container', ctx.name, 'AGENTS.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

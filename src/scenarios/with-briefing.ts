import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-briefing` — verifies the AI-tool briefing pipeline that
 * `monoceros apply` writes at the container workspace root: AGENTS.md,
 * CLAUDE.md and the chapters under .monoceros/. See workbench ADR 0014 for
 * where they live and ADR 0039 for the order they are in.
 *
 * Unit tests (`apply-yml.test.ts` in the workbench) already prove the
 * files land at the expected host path. What unit tests can't prove
 * and this scenario does:
 *
 *   - The files are reachable from **inside** the running container at
 *     `/workspaces/<name>/…`, matching the walk-up topology a real AI
 *     tool relies on.
 *   - The Prod path of `loadFeatureManifestSummary` finds the
 *     `manifests:sync`-bundled feature manifests (not just the dev
 *     checkout).
 *   - `whenOption` gating actually filters lines end-to-end —
 *     `atlassian/rovodev` is the sub-component that activates Rovo Dev
 *     while explicitly opting out of twg, so the briefing must list
 *     Rovo Dev but not the Teamwork Graph line.
 *
 * Lifecycle:
 *   1. `monoceros init … --with-features=atlassian/rovodev` (rovodev
 *      only — sets the atlassian feature's `twg: false`).
 *   2. `monoceros apply` materialises the container, scaffold + briefing.
 *   3. File-existence checks for every briefing file, imports included.
 *   4. Walk-up reachability from a mocked
 *      `projects/<probe>/` subdirectory.
 *   5. Content greps: stack and feature-line filtering reflect the yml.
 *
 * Bewusst NICHT geprüft:
 *   - Dass Claude Code die Datei tatsächlich lädt — Claude-internes
 *     Verhalten, vom CLI-Skript nicht antriggerbar.
 *   - Marker-preserving Re-Apply — durch
 *     `briefing-write.test.ts` im Workbench-Repo abgedeckt.
 */
export const withBriefing: Scenario = {
  id: 'with-briefing',
  description:
    'init → apply → verify AGENTS.md / CLAUDE.md / the .monoceros chapters exist, walk-up works, rules come first, the stated line count is true, content reflects whenOption gating',
  estimatedSeconds: 120,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-languages=node --with-services=postgres --with-features=atlassian/rovodev`,
      async () => {
        await ctx.cli([
          'init',
          ctx.name,
          '--with-languages=node',
          '--with-services=postgres',
          '--with-features=atlassian/rovodev',
        ]);
      },
    );

    await ctx.step(`apply ${ctx.name}`, async () => {
      await ctx.cli(['apply', ctx.name, '--yes']);
    });

    await ctx.step(`briefing files exist at /workspaces/${ctx.name}/`, () =>
      assertFilesExist(ctx),
    );

    await ctx.step(
      `walk-up from a mocked projects subdirectory finds the briefing`,
      () => assertWalkUpReaches(ctx),
    );

    await ctx.step(
      `AGENTS.md content reflects the yml + whenOption gating`,
      () => assertAgentsContent(ctx),
    );

    await ctx.step(
      `AGENTS.md's stated line count matches the file on disk`,
      () => assertStatedLineCount(ctx),
    );

    await ctx.step(`CLAUDE.md is the @AGENTS.md import inside markers`, () =>
      assertClaudeContent(ctx),
    );

    await ctx.step(`.monoceros/commands.md is a valid command reference`, () =>
      assertCommandsContent(ctx),
    );
  },
};

const workspaceRoot = (name: string) => `/workspaces/${name}`;

async function assertFilesExist(ctx: ScenarioCtx): Promise<void> {
  const root = workspaceRoot(ctx.name);
  const script = [
    `test -f ${root}/AGENTS.md || { echo missing-agents; exit 1; }`,
    `test -f ${root}/CLAUDE.md || { echo missing-claude; exit 1; }`,
    `test -f ${root}/.monoceros/commands.md || { echo missing-commands; exit 1; }`,
    // The chapters AGENTS.md imports (workbench ADR 0039). An import
    // pointing at a missing file is worse than no import at all.
    `test -f ${root}/.monoceros/conventions.md || { echo missing-conventions; exit 1; }`,
    `test -f ${root}/.monoceros/servers.md || { echo missing-servers; exit 1; }`,
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
    'AGENTS.md, CLAUDE.md and the .monoceros chapters all present',
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
}

/**
 * Stand-in for a real Claude session: create an empty subdirectory
 * under `projects/`, `cd` into it, and dereference the briefing files
 * via `../../…`. If the walk-up topology in ADR 0014 is wrong (e.g.
 * because the workspace mount moved), this fails — exactly what the
 * scenario is here to catch.
 */
async function assertWalkUpReaches(ctx: ScenarioCtx): Promise<void> {
  const root = workspaceRoot(ctx.name);
  const probeDir = `${root}/projects/e2e-probe`;
  const script = [
    `mkdir -p ${probeDir}`,
    `cd ${probeDir}`,
    `test -f ../../AGENTS.md || { echo missing-agents; exit 1; }`,
    `test -f ../../CLAUDE.md || { echo missing-claude; exit 1; }`,
    `test -f ../../.monoceros/commands.md || { echo missing-commands; exit 1; }`,
    `rm -rf ${probeDir}`,
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
    'briefing reachable via ../../ from a projects subdirectory',
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
}

async function assertAgentsContent(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'cat',
    `${workspaceRoot(ctx.name)}/AGENTS.md`,
  ]);
  ctx.expect(
    'cat AGENTS.md exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim()}`,
  );
  const body = result.stdout;

  ctx.expect(
    'AGENTS.md is wrapped in Monoceros marker comments',
    body.includes('<!-- monoceros:begin -->') &&
      body.includes('<!-- monoceros:end -->'),
    'marker pair not found',
  );
  ctx.expect(
    'AGENTS.md substitutes the real container name',
    body.includes(`monoceros apply ${ctx.name}`),
    'expected `monoceros apply <name>` example with the e2e container name',
  );
  ctx.expect(
    'AGENTS.md lists Node.js under the Languages section',
    /### Languages[\s\S]*Node\.js/.test(body),
    'Node.js bullet not found under ### Languages',
  );
  ctx.expect(
    'AGENTS.md lists the postgres service',
    /\*\*postgres\*\*\s+— reachable at `postgres:5432`/.test(body),
    'postgres service line not found',
  );
  ctx.expect(
    'AGENTS.md shows Atlassian Rovo Dev (rovodev option active)',
    /Atlassian Rovo Dev/.test(body),
    'Rovo Dev line not found',
  );
  ctx.expect(
    'AGENTS.md does NOT show Teamwork Graph (twg disabled by sub-component)',
    !/Teamwork Graph/.test(body),
    'twg line present despite atlassian/rovodev sub-component',
  );
  ctx.expect(
    'AGENTS.md imports the commands reference',
    body.includes('@.monoceros/commands.md'),
    '@.monoceros/commands.md import line not found',
  );
  // Rules before inventory before background (workbench ADR 0039): an
  // agent that reads only the first screen must land on the rules.
  const rules = body.indexOf('## Rules');
  const inventory = body.indexOf('## What is here');
  const background = body.indexOf('## What Monoceros is');
  ctx.expect(
    'AGENTS.md leads with the rules, then the inventory, then the background',
    rules > -1 && rules < inventory && inventory < background,
    `offsets: rules=${rules} inventory=${inventory} background=${background}`,
  );
  ctx.expect(
    'AGENTS.md imports the two chapters it moved out',
    body.includes('@.monoceros/conventions.md') &&
      body.includes('@.monoceros/servers.md'),
    'one of the chapter imports is missing',
  );
}

/**
 * The briefing states its own line count so a truncated read has a
 * visible contradiction in front of it. The number is generated from the
 * finished file, so it must equal `wc -l` on the real thing — and a
 * leftover placeholder would show up here too.
 */
async function assertStatedLineCount(ctx: ScenarioCtx): Promise<void> {
  const file = `${workspaceRoot(ctx.name)}/AGENTS.md`;
  const script = [
    `claimed=$(grep -o 'This file is [0-9]* lines long' ${file} | grep -o '[0-9]*')`,
    `actual=$(wc -l < ${file} | tr -d ' ')`,
    `test "$claimed" = "$actual" && echo ok || echo "claimed=$claimed actual=$actual"`,
  ].join('; ');
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    'the line count in the header equals `wc -l` on AGENTS.md',
    result.exitCode === 0 && result.stdout.trim().endsWith('ok'),
    `exit ${result.exitCode}: ${result.stdout.trim()} / ${result.stderr.trim()}`,
  );
}

async function assertClaudeContent(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'cat',
    `${workspaceRoot(ctx.name)}/CLAUDE.md`,
  ]);
  ctx.expect(
    'cat CLAUDE.md exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim()}`,
  );
  const body = result.stdout;
  ctx.expect(
    'CLAUDE.md is wrapped in Monoceros marker comments',
    body.includes('<!-- monoceros:begin -->') &&
      body.includes('<!-- monoceros:end -->'),
    'marker pair not found',
  );
  ctx.expect(
    'CLAUDE.md imports @AGENTS.md',
    body.includes('@AGENTS.md'),
    '@AGENTS.md import line not found',
  );
}

async function assertCommandsContent(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'cat',
    `${workspaceRoot(ctx.name)}/.monoceros/commands.md`,
  ]);
  ctx.expect(
    'cat .monoceros/commands.md exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim()}`,
  );
  const body = result.stdout;
  ctx.expect(
    'commands.md has the expected header',
    body.startsWith('# monoceros — Command reference'),
    `first line was: ${JSON.stringify(body.split('\n', 1)[0])}`,
  );
  ctx.expect(
    'commands.md references `monoceros apply`',
    /### `monoceros apply\b/.test(body),
    'apply subcommand heading not found',
  );
  ctx.expect(
    'commands.md groups commands under Container lifecycle',
    body.includes('## Container lifecycle'),
    'Container lifecycle section not found',
  );
}

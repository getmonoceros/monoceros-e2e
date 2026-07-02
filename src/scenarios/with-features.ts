import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-features` — installs every Monoceros-authored tool feature into
 * ONE container (one apply, to stay within the e2e time budget) and
 * verifies, without any credentials:
 *
 *   Level 1 — presence: each CLI answers `--version` (exit 0). Proves the
 *     feature's install.sh actually produced a working binary on PATH —
 *     the e2e builds features from THIS branch's source
 *     (MONOCEROS_FEATURES_DIR_OVERRIDE), so this gates install.sh
 *     regressions before the GHCR publish.
 *   Level 2 — apply-time wiring: the config Monoceros writes on apply is
 *     present (claude settings.json defaultMode; opencode.json
 *     instructions + external_directory). Guards the connectionEnv-class
 *     of regression on the feature side.
 *
 * Auth/login is out of scope (needs real tokens); feature login hooks
 * no-op without credentials, so the CLIs still install.
 *
 * NOTE: `atlassian` is temporarily removed — its `twg` installer fetches
 * an Atlassian URL that is currently serving HTML instead of the script
 * (upstream breakage), which fails the whole feature build. Re-add it
 * (and the acli/twg checks below) once that endpoint is fixed. See
 * getmonoceros/workbench#35.
 */
export const withFeatures: Scenario = {
  id: 'with-features',
  description:
    'init → apply (claude, opencode, github, gitlab) → assert each CLI --version + claude/opencode wiring → remove',
  estimatedSeconds: 240,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-features=claude,opencode,github,gitlab`,
      () =>
        ctx.cli([
          'init',
          ctx.name,
          '--with-features=claude,opencode,github,gitlab',
        ]),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    // Level 1 — every tool's binary is installed and on PATH.
    const tools: Array<[string, string]> = [
      ['claude', 'claude --version'],
      ['opencode', 'opencode --version'],
      ['gh (github)', 'gh --version'],
      ['glab (gitlab)', 'glab --version'],
      // acli/twg (atlassian) temporarily removed — see the note above
      // and getmonoceros/workbench#35.
    ];
    for (const [label, cmd] of tools) {
      await ctx.step(`${label} installed`, () => assertOk(ctx, label, cmd));
    }

    // Level 2 — apply-time config Monoceros writes for these features.
    await ctx.step('claude settings.json has permissions.defaultMode', () =>
      assertFileContains(
        ctx,
        '~/.claude/settings.json',
        ['defaultMode'],
        'claude settings.json',
      ),
    );
    await ctx.step('opencode.json has instructions + external_directory', () =>
      assertFileContains(
        ctx,
        '~/.config/opencode/opencode.json',
        ['instructions', 'external_directory'],
        'opencode.json',
      ),
    );
  },
};

async function assertOk(
  ctx: ScenarioCtx,
  label: string,
  cmd: string,
): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    cmd,
  ]);
  ctx.expect(
    `${label}: \`${cmd}\` exits 0`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-300)}`,
  );
}

async function assertFileContains(
  ctx: ScenarioCtx,
  file: string,
  needles: string[],
  label: string,
): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cat ${file}`,
  ]);
  const out = result.stdout;
  const missing = needles.filter((n) => !out.includes(n));
  ctx.expect(
    `${label} present with ${needles.map((n) => `\`${n}\``).join(', ')}`,
    result.exitCode === 0 && missing.length === 0,
    result.exitCode !== 0
      ? `cat ${file} exit ${result.exitCode}: ${result.stderr.trim()}`
      : `missing: ${missing.join(', ')} — content: ${out.trim().slice(0, 300)}`,
  );
}

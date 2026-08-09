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
 *   Level 3 — graphify's upstream canary: the skill registered for both
 *     agents present, and a graph actually builds. graphify is pre-1.0 and
 *     ships every few days while features install `latest` by design, so
 *     the two things that can move under us get exercised rather than
 *     pinned: the `install` flags and the `graphify-out/` layout. Since
 *     claude and opencode are both in this container, it also proves the
 *     registration is derived from the agents present (ADR 0049).
 *
 * Auth/login is out of scope (needs real tokens); the atlassian feature's
 * login hooks no-op without credentials, so acli/twg still install.
 */
export const withFeatures: Scenario = {
  id: 'with-features',
  description:
    'init → apply (claude, opencode, github, gitlab, atlassian, graphify) → assert each CLI --version + claude/opencode wiring + a graphify graph → remove',
  estimatedSeconds: 300,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-features=claude,opencode,github,gitlab,atlassian,graphify`,
      () =>
        ctx.cli([
          'init',
          ctx.name,
          '--with-features=claude,opencode,github,gitlab,atlassian,graphify',
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
      ['acli (atlassian rovodev)', 'acli --version'],
      ['twg (atlassian)', 'twg --version'],
      // Deliberately `bash -c` without `-l`: graphify is installed into a uv
      // tool venv under ~/.local/share, and its launcher is only reachable
      // because install.sh symlinks it onto the system PATH. A login shell
      // would pass on ~/.profile's ~/.local/bin instead and prove nothing.
      ['graphify', 'graphify --version'],
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

    // Level 3 — graphify. The post-create hook detects the agents in the
    // container, so both skills have to be there: one call per platform, and
    // nothing configured in the yml.
    await ctx.step('graphify skill registered for claude', () =>
      assertOk(
        ctx,
        'graphify claude skill',
        'test -f ~/.claude/skills/graphify/SKILL.md',
      ),
    );
    await ctx.step('graphify skill registered for opencode', () =>
      assertOk(
        ctx,
        'graphify opencode skill',
        'test -f ~/.config/opencode/skills/graphify/SKILL.md',
      ),
    );

    // The canary itself: a real graph over two files that call each other.
    // `--code-only` because a corpus with any doc file needs a model, and this
    // run has no key — the fixture's README is there to exercise exactly that
    // path. GRAPH_REPORT.md and graph.html are NOT asserted: they take a
    // second `cluster-only` run and the build alone does not write them.
    await ctx.step('graphify builds a graph and answers a query', () =>
      assertOk(
        ctx,
        'graphify graph',
        [
          'set -e',
          'rm -rf /tmp/gfy && mkdir -p /tmp/gfy && cd /tmp/gfy',
          'printf "from b import helper\\n\\nclass Runner:\\n    def run(self):\\n        return helper(1)\\n" > a.py',
          'printf "def helper(x):\\n    return x + 1\\n" > b.py',
          'printf "# fixture\\n" > README.md',
          'graphify . --code-only',
          'test -f graphify-out/graph.json',
          // The edge a call graph exists for. A build that produced a file but
          // resolved no calls would otherwise pass.
          'graphify query "what calls helper?" | grep -q "calls"',
        ].join('\n'),
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

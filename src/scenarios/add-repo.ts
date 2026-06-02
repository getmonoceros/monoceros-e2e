import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';

/**
 * `add-repo` — proves the on-the-fly clone path.
 *
 * Distinct from `--with-repos` (init-time clone, exercised by
 * with-services / with-port): `monoceros add-repo` updates the yml
 * AND tries to clone into the **running** container in the same call,
 * no re-apply needed. Two code paths, both worth proving.
 *
 * Verification approach: clone the fixture, then start serve-ports.mjs
 * inside the container and probe it from inside the container via
 * curl on 127.0.0.1:3000. We deliberately don't add-port here — that
 * would couple the test to Traefik routing, which is what `with-port`
 * covers. The internal probe proves "repo arrived, script is
 * functional" without dragging the proxy in.
 */
export const addRepo: Scenario = {
  id: 'add-repo',
  description:
    'init → apply → add-repo (on-the-fly clone) → in-container serve-ports probe → remove',
  estimatedSeconds: 90,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-languages=node (NO --with-repos)`, () =>
      ctx.cli(['init', ctx.name, '--with-languages=node']),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(
      `add-repo ${ctx.name} <fixture> (on-the-fly clone into running container)`,
      () => ctx.cli(['add-repo', ctx.name, FIXTURE_REPO, '--yes']),
    );

    await ctx.step(`fixture files are present in the running container`, () =>
      assertFixtureFilesPresent(ctx),
    );

    await ctx.step(`start serve-ports (port 3000) in background`, () =>
      startServeBackground(ctx),
    );

    await ctx.step(`serve-ports answers on 127.0.0.1:3000 with port=3000`, () =>
      probeInternal(ctx),
    );
  },
};

/**
 * Verify the cloned repo arrived by running `ls` inside the container
 * on the expected file. The error message from `monoceros run` when
 * the file is missing is descriptive enough — we just turn the exit
 * code into a labelled expectation.
 */
async function assertFixtureFilesPresent(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `test -f ${FIXTURE_DIR}/serve-ports.mjs && test -f ${FIXTURE_DIR}/package.json && echo present`,
  ]);
  ctx.expect(
    `${FIXTURE_DIR}/serve-ports.mjs and package.json exist`,
    result.exitCode === 0 && result.stdout.trim().endsWith('present'),
    result.exitCode === 0
      ? `unexpected stdout: ${result.stdout.trim()}`
      : `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

async function startServeBackground(ctx: ScenarioCtx): Promise<void> {
  // serve-ports.mjs has zero dependencies (pure Node stdlib), so no
  // `npm install` needed. Just background-start it on port 3000.
  await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `nohup node ${FIXTURE_DIR}/serve-ports.mjs 3000 > /tmp/serve-ports.log 2>&1 & disown; sleep 1; echo started`,
  ]);
}

/**
 * Probe serve-ports from INSIDE the container — curl 127.0.0.1:3000.
 * No Traefik involvement; we're only proving the repo's content runs
 * and answers. The body is JSON; we look for `"port":3000` in it.
 */
async function probeInternal(ctx: ScenarioCtx): Promise<void> {
  const script = `
    for i in $(seq 1 15); do
      body=$(curl -sf http://127.0.0.1:3000/ 2>/dev/null)
      if [ -n "$body" ]; then
        echo "$body"
        exit 0
      fi
      sleep 1
    done
    echo timeout
    exit 1
  `;
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    `curl http://127.0.0.1:3000/ in workspace succeeds`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
  const body = result.stdout.trim();
  let parsed: { port?: number } | null = null;
  try {
    parsed = JSON.parse(body) as { port?: number };
  } catch {
    ctx.expect(
      `response body is valid JSON`,
      false,
      `got: ${body.slice(0, 200)}`,
    );
    return;
  }
  ctx.expect(
    `response body has port=3000`,
    parsed.port === 3000,
    `got port=${parsed.port}`,
  );
  ctx.info('serve-ports.mjs is running inside the container and responding.');
}

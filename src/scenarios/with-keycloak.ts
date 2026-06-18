import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-keycloak` — the end-to-end proof for deferred service start
 * (ADR 0025). Keycloak needs its realm.json present at boot, but the
 * realm is a project artifact that only lands via the in-container repo
 * clone (post-create), AFTER the services would normally start. The
 * curated keycloak service is `deferStart`, so Monoceros brings it up in
 * a host-side second wave once the clone has run.
 *
 * The strecke:
 *   - init keycloak + the fixture repo (the realm lives in the fixture).
 *   - uncomment + point the keycloak `volumes:` scaffold at the fixture
 *     realm (what a builder does by hand — there is no add-volume CLI).
 *   - apply: keycloak starts in the second wave and imports the realm.
 *   - OIDC client-credentials token round-trip against the imported
 *     realm proves the realm was mounted, imported, and authenticates —
 *     which only works because the file was on disk at the (deferred)
 *     boot. A regression of the deferred start would yield an empty
 *     Keycloak and a 404 on the realm.
 *
 * The probe asserts `KEYCLOAK_URL` (ADR 0021) and uses only the built-in
 * `fetch`, so no `npm ci` is needed.
 */

const FIXTURE_REPO = 'https://github.com/getmonoceros/monoceros-e2e-fixture';
const FIXTURE_DIR = 'projects/monoceros-e2e-fixture';
const REALM_MOUNT = `${FIXTURE_DIR}/keycloak/e2e-realm.json:/opt/keycloak/data/import/e2e.json:ro`;

export const withKeycloak: Scenario = {
  id: 'with-keycloak',
  description:
    'init → mount fixture realm → apply (deferred start) → OIDC token round-trip proves realm import + auth (Compose-Mode, keycloak, ADR 0025)',
  estimatedSeconds: 240,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-services=keycloak --with-repos=…/monoceros-e2e-fixture`,
      () =>
        ctx.cli([
          'init',
          ctx.name,
          '--with-languages=node',
          '--with-services=keycloak',
          `--with-repos=${FIXTURE_REPO}`,
        ]),
    );

    await ctx.step(
      'mount the fixture realm into keycloak (fill the volumes scaffold)',
      async () => mountRealm(ctx),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step(
      'OIDC client-credentials token round-trip against the imported realm',
      () => runProbe(ctx),
    );
  },
};

/**
 * Add the realm bind-mount to the keycloak service in the generated yml.
 * The curated entry ships a COMMENTED `volumes:` scaffold (the catalog
 * can't know the repo path); a builder uncomments it and sets the path.
 * We do the same by inserting an active `volumes:` block right after the
 * service's `command:` line (a stable anchor) — keeping it independent of
 * the exact comment text of the scaffold.
 */
function mountRealm(ctx: ScenarioCtx): void {
  const home =
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    );
  const ymlPath = path.join(home, 'container-configs', `${ctx.name}.yml`);
  const yml = readFileSync(ymlPath, 'utf8');

  const anchor = '    command: start-dev --import-realm\n';
  if (!yml.includes(anchor)) {
    throw new Error(
      `keycloak command anchor not found in ${ymlPath} — did the curated keycloak service change?`,
    );
  }
  const withVolume = yml.replace(
    anchor,
    `${anchor}    volumes:\n      - ${REALM_MOUNT}\n`,
  );
  writeFileSync(ymlPath, withVolume, 'utf8');
  ctx.info(`mounted ${REALM_MOUNT}`);
}

async function runProbe(ctx: ScenarioCtx): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    `cd ${FIXTURE_DIR} && node keycloak-client.mjs`,
  ]);
  const tail = result.stdout.trim().split('\n').slice(-1)[0] ?? '';
  ctx.expect(
    'keycloak probe exits 0',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim().slice(-400)}`,
  );
  ctx.expect(
    'keycloak probe stdout ends with `ok`',
    tail === 'ok',
    `last line: ${JSON.stringify(tail)} — full: ${result.stdout.trim().slice(-400)}`,
  );
}

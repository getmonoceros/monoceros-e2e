import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Scenario, ScenarioCtx } from '../lib/scenario.js';
import { runDocker } from '../lib/docker.js';

/**
 * `with-deploy-blocks` — die Pipeline-Blöcke aus dem Katalog starten wirklich.
 *
 * `apply` rendert pro Service einen fertigen Compose-Block nach
 * `.monoceros/deploy.md` (ADR 0037); der Agent im Container kopiert ihn
 * wörtlich. Geprüft hat das bisher nichts, und der erste Handlauf fand
 * prompt einen Healthcheck, der nie grün wird (rustfs antwortete 403 auf dem
 * MinIO-kompatiblen Pfad). Dieses Szenario macht genau diesen Handlauf
 * automatisch — ohne Agent: es liest die gerenderten Blöcke, setzt sie
 * zusammen wie der Agent es täte, und zieht sie hoch.
 *
 * Lifecycle:
 *   1. `init` mit den Services, die zusammen alle Block-Formen abdecken, +
 *      `apply`.
 *   2. Blöcke aus `.monoceros/deploy.md` lesen und zu EINER compose-Datei
 *      zusammenführen: ein `services:`-Mapping, ein `volumes:`-Mapping.
 *   3. `docker compose config` OHNE die Pflichtwerte muss scheitern — das ist
 *      die `${VAR:?}`-Garantie, die verhindert, dass ein vergessener Wert
 *      einen erreichbaren Dienst auf Katalog-Zugangsdaten startet.
 *   4. Mit den Werten: `config` läuft, und `up -d --wait` bringt jeden Dienst
 *      auf healthy.
 *   5. Zwei Prüfungen über healthy hinaus, weil healthy kein Beweis ist:
 *      Redis lehnt ein unauthentifiziertes `ping` ab, und Keycloak liefert den
 *      importierten Realm aus.
 *
 * Bewusste Grenze: vier der acht Services sind drin (postgres, redis,
 * keycloak, rustfs). Sie decken die vier Block-Formen ab — schlichter Block,
 * Block mit `command` + Passwort, Block mit `deploy.requires` (eigene
 * Datenbank + Volume), Block mit eigenem Volume. mysql, mongodb, pgvector und
 * mailpit wiederholen diese Formen und würden nur Pull-Zeit kosten; ihre
 * Blöcke werden nicht gestartet.
 */

const SERVICES = ['postgres', 'redis', 'keycloak', 'rustfs'] as const;

/**
 * Werte für die `${VAR:?}`-Pflichtvariablen der Blöcke. Die Liste wird nicht
 * gepflegt, sondern aus der zusammengesetzten Datei gelesen; hier stehen nur
 * die, bei denen ein beliebiger String nicht genügt. Alles Neue bekommt
 * automatisch einen Platzhalter, damit ein zusätzlicher Block das Szenario
 * nicht mit einer unverständlichen Meldung umlegt.
 */
const SPECIAL_VALUES: Record<string, string> = {
  KC_HOSTNAME: 'http://localhost:8080',
};
const GENERIC_VALUE = 'e2e-value';

export const withDeployBlocks: Scenario = {
  id: 'with-deploy-blocks',
  description:
    'apply → assemble .monoceros/deploy.md into one compose file → config fails without secrets, succeeds with → up --wait all healthy + auth asserts',
  estimatedSeconds: 420,
  async run(ctx) {
    await ctx.step(
      `init ${ctx.name} --with-services=${SERVICES.join(',')}`,
      () =>
        ctx.cli([
          'init',
          ctx.name,
          '--with-languages=node',
          `--with-services=${SERVICES.join(',')}`,
        ]),
    );

    await ctx.step(`apply ${ctx.name}`, () => ctx.cli(['apply', ctx.name]));

    const dir = await ctx.step(
      'assemble the rendered blocks into one compose file',
      () => assembleCompose(ctx),
    );
    const project = `${ctx.name}-deploy`;

    try {
      await ctx.step('compose config fails without the required values', () =>
        expectConfigFails(ctx, dir),
      );

      await ctx.step('compose config succeeds with them', () =>
        expectConfigSucceeds(ctx, dir),
      );

      await ctx.step('every service reaches healthy', () =>
        composeUp(ctx, dir, project),
      );

      await ctx.step('redis rejects an unauthenticated ping', () =>
        expectRedisRequiresAuth(ctx, project),
      );

      await ctx.step('keycloak serves the imported realm', () =>
        expectRealmServed(ctx, project),
      );
    } finally {
      await ctx.step('tear the assembled stack down', async () => {
        // With the values, not without: `down` interpolates the file too, so
        // the `${VAR:?}` guards stop it just as they stop `up`. Without them
        // the teardown exits non-zero and leaves the stack and its volumes
        // behind, which then poisons the next run.
        const env = await requiredEnv(dir);
        const result = await runCompose(
          dir,
          project,
          ['down', '-v', '--remove-orphans'],
          env,
        );
        ctx.expect(
          'the assembled stack and its volumes are gone',
          result.exitCode === 0,
          `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-300)}`,
        );
        await fs.rm(dir, { recursive: true, force: true });
      });
    }
  },
};

/**
 * Read `.monoceros/deploy.md` and merge every block into one compose file, the
 * same merge the agent does: each service's own block goes under `services:`,
 * and a `deploy.requires` fragment contributes its top-level `services:` and
 * `volumes:` entries into the same two mappings instead of repeating the keys.
 */
async function assembleCompose(ctx: ScenarioCtx): Promise<string> {
  const deployMd = path.join(
    monocerosHome(),
    'container',
    ctx.name,
    '.monoceros',
    'deploy.md',
  );
  const md = await fs.readFile(deployMd, 'utf8');

  const services: string[] = [];
  const volumes: string[] = [];
  for (const svc of SERVICES) {
    const section = sectionFor(md, svc);
    ctx.expect(`deploy.md has a block for ${svc}`, section !== null);
    if (!section) continue;

    const own = firstYamlBlock(section);
    ctx.expect(`the ${svc} block is not empty`, own !== null);
    if (own) services.push(...indent(own));

    const requires = requiresFragment(section);
    if (requires) {
      const { extraServices, extraVolumes } = splitFragment(requires);
      services.push(...extraServices);
      volumes.push(...extraVolumes);
      ctx.info(
        `${svc} brings its own parts: ${extraServices.length} service line(s), ` +
          `${extraVolumes.length} volume line(s)`,
      );
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monoceros-e2e-deploy-'));
  const lines = ['services:', ...services];
  if (volumes.length > 0) lines.push('volumes:', ...volumes);
  await fs.writeFile(
    path.join(dir, 'docker-compose.yml'),
    `${lines.join('\n')}\n`,
  );

  // Keycloak's block mounts the project's realm export. Without the file,
  // docker would create a DIRECTORY at that path and the import would do
  // nothing, so the scenario provides a minimal realm of its own.
  await fs.mkdir(path.join(dir, 'keycloak'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'keycloak', 'realm.json'),
    `${JSON.stringify({ realm: 'e2e', enabled: true }, null, 2)}\n`,
  );

  ctx.info(`assembled ${path.join(dir, 'docker-compose.yml')}`);
  return dir;
}

/** The part of deploy.md that belongs to one service heading. */
function sectionFor(md: string, service: string): string | null {
  const start = md.indexOf(`\n## ${service}\n`);
  if (start === -1) return null;
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

function firstYamlBlock(section: string): string | null {
  return yamlBlockAfter(section, 0);
}

function requiresFragment(section: string): string | null {
  const marker = section.indexOf('It needs these of its own:');
  if (marker === -1) return null;
  return yamlBlockAfter(section, marker);
}

function yamlBlockAfter(text: string, from: number): string | null {
  const open = text.indexOf('```yaml\n', from);
  if (open === -1) return null;
  const bodyStart = open + '```yaml\n'.length;
  const close = text.indexOf('```', bodyStart);
  if (close === -1) return null;
  return text.slice(bodyStart, close).replace(/\n+$/, '');
}

function indent(block: string): string[] {
  return block.split('\n').map((line) => (line.trim() ? `  ${line}` : line));
}

/** Split a top-level fragment into its `services:` and `volumes:` bodies. */
function splitFragment(fragment: string): {
  extraServices: string[];
  extraVolumes: string[];
} {
  const lines = fragment.split('\n');
  const svcAt = lines.indexOf('services:');
  const volAt = lines.indexOf('volumes:');
  const end = (from: number): number => {
    const candidates = [svcAt, volAt].filter((i) => i > from);
    return candidates.length > 0 ? Math.min(...candidates) : lines.length;
  };
  return {
    extraServices: svcAt === -1 ? [] : lines.slice(svcAt + 1, end(svcAt)),
    extraVolumes: volAt === -1 ? [] : lines.slice(volAt + 1, end(volAt)),
  };
}

/** Every `${VAR:?…}` the assembled file requires, with a usable value. */
async function requiredEnv(dir: string): Promise<Record<string, string>> {
  const text = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
  const env: Record<string, string> = {};
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) {
    const name = match[1]!;
    env[name] = SPECIAL_VALUES[name] ?? GENERIC_VALUE;
  }
  return env;
}

async function runCompose(
  dir: string,
  project: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await runDocker([
      'compose',
      '--project-directory',
      dir,
      '-f',
      path.join(dir, 'docker-compose.yml'),
      '-p',
      project,
      ...args,
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function expectConfigFails(ctx: ScenarioCtx, dir: string): Promise<void> {
  const result = await runCompose(dir, 'unused', ['config']);
  ctx.expect(
    'compose refuses to render without the required values',
    result.exitCode !== 0,
    'compose config succeeded, so a block carries a default it should not',
  );
  ctx.expect(
    'the error names the missing variable',
    /required variable/i.test(result.stderr),
    `stderr: ${result.stderr.trim().slice(0, 300)}`,
  );
}

async function expectConfigSucceeds(
  ctx: ScenarioCtx,
  dir: string,
): Promise<void> {
  const env = await requiredEnv(dir);
  const result = await runCompose(dir, 'unused', ['config'], env);
  ctx.expect(
    'compose renders with the required values set',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
  );
  ctx.info(`required values: ${Object.keys(env).sort().join(', ')}`);
}

async function composeUp(
  ctx: ScenarioCtx,
  dir: string,
  project: string,
): Promise<void> {
  const env = await requiredEnv(dir);
  const result = await runCompose(dir, project, ['up', '-d', '--wait'], env);
  ctx.expect(
    'every assembled service becomes healthy',
    result.exitCode === 0,
    `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-600)}`,
  );
}

/**
 * The redis block runs `--requirepass`, which is the whole reason it differs
 * from the dev shape. `redis-cli ping` without credentials must be refused.
 */
async function expectRedisRequiresAuth(
  ctx: ScenarioCtx,
  project: string,
): Promise<void> {
  const result = await runDocker([
    'exec',
    `${project}-redis-1`,
    'redis-cli',
    'ping',
  ]);
  ctx.expect(
    'unauthenticated ping is refused',
    /NOAUTH/i.test(result.stdout + result.stderr),
    `stdout: ${result.stdout.trim()} stderr: ${result.stderr.trim()}`,
  );
}

/**
 * Keycloak's block runs `start --import-realm` against its own database, so a
 * healthy container should also serve the realm from the mounted file. The
 * image ships no curl, so bash opens the socket itself.
 */
async function expectRealmServed(
  ctx: ScenarioCtx,
  project: string,
): Promise<void> {
  const script =
    'exec 3<>/dev/tcp/127.0.0.1/8080; ' +
    "printf 'GET /realms/e2e/.well-known/openid-configuration HTTP/1.1\\r\\n" +
    "Host: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3; cat <&3";
  const result = await runDocker([
    'exec',
    `${project}-keycloak-1`,
    'bash',
    '-c',
    script,
  ]);
  ctx.expect(
    'the imported realm answers with its issuer',
    result.stdout.includes('"issuer"'),
    `response: ${result.stdout.trim().slice(0, 300)}`,
  );
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

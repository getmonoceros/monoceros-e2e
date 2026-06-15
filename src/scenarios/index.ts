import type { Scenario } from '../lib/scenario.js';
import { minimal } from './minimal.js';
import { withServices } from './with-services.js';
import { withMysql } from './with-mysql.js';
import { withRedis } from './with-redis.js';
import { withPgvector } from './with-pgvector.js';
import { withMongodb } from './with-mongodb.js';
import { withRustfs } from './with-rustfs.js';
import { withMailpit } from './with-mailpit.js';
import { withFeatures } from './with-features.js';
import { withPort } from './with-port.js';
import { addRepo } from './add-repo.js';
import { withMutations } from './with-mutations.js';
import { withTunnel } from './with-tunnel.js';
import { withBriefing } from './with-briefing.js';
import { imageModeZombie } from './image-mode-zombie.js';
import { upgrade } from './upgrade.js';

/**
 * Single source of truth for the available scenarios. `monoceros-e2e
 * list` reads this; `run <id>` looks up the entry; `run --all`
 * iterates it in order.
 *
 * Order is intentional — newcomers / sanity-checks first, heavier
 * stuff later. `--all` follows this order.
 */
export const SCENARIOS: Scenario[] = [
  minimal,
  withServices,
  withMysql,
  withRedis,
  withPgvector,
  withMongodb,
  withRustfs,
  withMailpit,
  withFeatures,
  withPort,
  addRepo,
  withMutations,
  withTunnel,
  withBriefing,
  imageModeZombie,
  upgrade,
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function listScenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}

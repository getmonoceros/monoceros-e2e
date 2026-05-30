import type { Scenario } from '../lib/scenario.js';
import { minimal } from './minimal.js';
import { withServices } from './with-services.js';
import { withPort } from './with-port.js';
import { addRepo } from './add-repo.js';
import { withMutations } from './with-mutations.js';

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
  withPort,
  addRepo,
  withMutations,
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function listScenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}

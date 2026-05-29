/**
 * Container-Namenskonvention für E2E-Szenarien.
 *
 * Format: `e2e-<scenario>-<YYYY-MM-DD-HHMM>`
 *
 * Der Präfix `e2e-` ist die Anker-Bedingung, an der die Pre-Flight-
 * Cleanup-Logik erkennt, was sie wegräumen darf. Das ZEITSTEMPEL-
 * Suffix ist debug-freundlich (du siehst „der ist von vorgestern")
 * und kollisionsfrei genug für den Single-Maintainer-Use-Case.
 *
 * Bewusst keine Sekunden — Minutenauflösung reicht, und kürzere Namen
 * sind in `docker ps`-Output und Terminal-Output lesbarer.
 */

const PREFIX = 'e2e-';

export interface NameOptions {
  /** Optionale fixe Uhrzeit (Tests setzen das). */
  now?: Date;
}

/**
 * Build `e2e-<scenario>-<YYYY-MM-DD-HHMM>` für ein gegebenes
 * Szenario. Aktuelle Zeit wird in lokaler Zeit formatiert — das matcht,
 * was der Maintainer im Terminal sieht, und der Use-Case ist lokal,
 * nicht verteilt.
 */
export function scenarioContainerName(
  scenario: string,
  opts: NameOptions = {},
): string {
  const d = opts.now ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${PREFIX}${scenario}-${yyyy}-${mm}-${dd}-${hh}${mi}`;
}

/** Tests, whether `name` follows the e2e-naming convention. */
export function isE2EName(name: string): boolean {
  return name.startsWith(PREFIX);
}

/** Anchor regex for `docker ps --filter "name=^…"`. */
export const E2E_DOCKER_NAME_FILTER = '^e2e-';

/** Glob pattern for `$MONOCEROS_HOME/container-configs/`. */
export const E2E_YML_GLOB = 'e2e-*.yml';

/** Bare prefix — exposed so other modules don't duplicate the literal. */
export const E2E_PREFIX = PREFIX;

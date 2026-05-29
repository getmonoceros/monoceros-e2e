import { consola } from 'consola';

/**
 * Output adapter. Two backends:
 *
 *   - **pretty** (default) — coloured, human-friendly, via consola.
 *     What the maintainer sees on their laptop.
 *   - **gh** — GitHub-Actions workflow commands (`::group::` /
 *     `::notice::` / `::error::` markers) so the PR UI surfaces step
 *     results inline. Activated when `GITHUB_ACTIONS=true`.
 *
 * Detection is automatic; callers don't pick. Keeps the scenario code
 * env-agnostic.
 */

export interface Output {
  /** Plain log line between or inside steps. */
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Visually opens a step block (start marker). */
  stepStart: (label: string) => void;
  /** Closes a step block with a PASS marker + timing. */
  stepPass: (label: string, ms: number) => void;
  /** Closes a step block with a FAIL marker, error message + timing. */
  stepFail: (label: string, err: Error, ms: number) => void;
  /** Indented assertion line inside a step — visible „passed" check. */
  check: (label: string) => void;
  /** End-of-scenario summary block — title + outcome + duration. */
  summary: (input: SummaryInput) => void;
}

export interface SummaryInput {
  scenarioId: string;
  ok: boolean;
  durationMs: number;
  containerName: string;
  errorMessage?: string;
}

const isGitHubActions = (): boolean =>
  (process.env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true';

export function makeOutput(): Output {
  return isGitHubActions() ? ghOutput() : prettyOutput();
}

function prettyOutput(): Output {
  return {
    info: (m) => consola.info(m),
    warn: (m) => consola.warn(m),
    error: (m) => consola.error(m),
    stepStart: (label) => {
      process.stdout.write('\n');
      consola.start(label);
    },
    stepPass: (label, ms) => consola.success(`${label}  (${formatMs(ms)})`),
    stepFail: (label, err, ms) =>
      consola.fail(`${label}  (${formatMs(ms)}) — ${err.message}`),
    check: (label) => {
      // Indented green check, distinct from step-level markers.
      process.stdout.write(`    \x1b[32m✓\x1b[0m ${label}\n`);
    },
    summary: (s) => {
      const mark = s.ok ? '\x1b[32m✓ PASSED\x1b[0m' : '\x1b[31m✗ FAILED\x1b[0m';
      const dur = formatMs(s.durationMs);
      const lines: string[] = [
        '',
        '═══════════════════════════════════════════════════════',
        `  ${mark}  ${s.scenarioId}  (${dur})`,
        `  container: ${s.containerName}`,
      ];
      if (!s.ok && s.errorMessage) {
        lines.push(`  reason:    ${s.errorMessage}`);
      }
      lines.push('═══════════════════════════════════════════════════════', '');
      process.stdout.write(lines.join('\n'));
    },
  };
}

function ghOutput(): Output {
  // GH workflow commands escape `%`, `\r`, `\n` in their payloads —
  // newlines in a single message line are the most common foot-gun.
  const esc = (s: string): string =>
    s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return {
    info: (m) => process.stdout.write(`::notice::${esc(m)}\n`),
    warn: (m) => process.stdout.write(`::warning::${esc(m)}\n`),
    error: (m) => process.stdout.write(`::error::${esc(m)}\n`),
    stepStart: (label) => process.stdout.write(`::group::${esc(label)}\n`),
    stepPass: (label, ms) => {
      process.stdout.write(`::endgroup::\n`);
      process.stdout.write(
        `::notice::${esc(`PASS: ${label} (${formatMs(ms)})`)}\n`,
      );
    },
    stepFail: (label, err, ms) => {
      process.stdout.write(`::endgroup::\n`);
      process.stdout.write(
        `::error::${esc(`FAIL: ${label} (${formatMs(ms)}) — ${err.message}`)}\n`,
      );
    },
    check: (label) =>
      // Inside an open ::group::, plain stdout shows up indented under
      // the group. No need for extra markers — the group's own pass/
      // fail outcome already surfaces.
      process.stdout.write(`  ✓ ${label}\n`),
    summary: (s) => {
      if (s.ok) {
        process.stdout.write(
          `::notice::${esc(`SCENARIO PASSED: ${s.scenarioId} (${formatMs(s.durationMs)}) — container ${s.containerName}`)}\n`,
        );
      } else {
        process.stdout.write(
          `::error::${esc(`SCENARIO FAILED: ${s.scenarioId} (${formatMs(s.durationMs)}) — container ${s.containerName}${s.errorMessage ? ` — ${s.errorMessage}` : ''}`)}\n`,
        );
      }
    },
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

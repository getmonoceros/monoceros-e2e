import { consola } from 'consola';

/**
 * Output adapter. Two backends:
 *
 *   - **pretty** (default) — coloured, human-friendly, via consola.
 *     What the maintainer sees on their laptop.
 *   - **gh** — GitHub-Actions workflow commands (`::notice::` /
 *     `::error::` markers) so the PR UI surfaces step results inline.
 *     Activated when `GITHUB_ACTIONS=true`.
 *
 * Detection is automatic; callers don't pick. Keeps the scenario code
 * env-agnostic.
 */

export interface Output {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Mark the start of a scenario step (e.g. "init", "apply"). */
  step: (label: string) => void;
  /** Mark the result of a step. */
  pass: (label: string, ms: number) => void;
  fail: (label: string, err: Error, ms: number) => void;
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
    step: (label) => consola.start(label),
    pass: (label, ms) => consola.success(`${label} (${formatMs(ms)})`),
    fail: (label, err, ms) =>
      consola.fail(`${label} (${formatMs(ms)}) — ${err.message}`),
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
    step: (label) => process.stdout.write(`::group::${esc(label)}\n`),
    pass: (label, ms) => {
      process.stdout.write(`::endgroup::\n`);
      process.stdout.write(`::notice::${esc(`${label} (${formatMs(ms)})`)}\n`);
    },
    fail: (label, err, ms) => {
      process.stdout.write(`::endgroup::\n`);
      process.stdout.write(
        `::error::${esc(`${label} (${formatMs(ms)}) — ${err.message}`)}\n`,
      );
    },
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

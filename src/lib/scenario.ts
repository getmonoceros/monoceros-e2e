import { run, capture } from './cli.js';
import { makeOutput, type Output } from './output.js';
import { scenarioContainerName } from './naming.js';

/**
 * Scenario interface — one TypeScript function per scenario, see
 * src/scenarios/*.ts. Each scenario owns its lifecycle (Setup → Asserts
 * → Teardown) and uses the `ctx` to drive monoceros + the output
 * adapter. Asserts are plain `throw new Error(…)`; the runner catches
 * and reports.
 */

export interface Scenario {
  /** Stable identifier; what `monoceros-e2e run <id>` matches. */
  id: string;
  /** One-line description for `monoceros-e2e list`. */
  description: string;
  /** Rough wall-time so the maintainer knows what they're signing up for. */
  estimatedSeconds: number;
  /** The body. Receives a `ctx` with helpers; throws on assertion failure. */
  run: (ctx: ScenarioCtx) => Promise<void>;
}

export interface ScenarioCtx {
  /** The container-name the scenario should use throughout (`e2e-…`). */
  name: string;
  /** Streaming `monoceros …` invocation. Throws on non-zero exit. */
  cli: (args: string[]) => Promise<number>;
  /** Buffered `monoceros …` invocation. */
  cliCapture: (args: string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /** Sub-step label for the output adapter. */
  step: (label: string) => void;
  /** Free-form info line (between steps). */
  info: (msg: string) => void;
  /**
   * Assertion helper — throws an Error with a useful message if
   * `cond` is falsy. Keeps the scenario code tight without pulling
   * `assert`/`chai`/whatever in.
   *
   * Note: NOT typed as `asserts cond` predicate because TS only
   * allows that on top-level functions, not on object methods (see
   * TS2775). Scenarios don't rely on flow-narrowing past the call
   * anyway — they assert and continue.
   */
  assert: (cond: unknown, msg: string) => void;
}

export interface RunScenarioOptions {
  /** `true` → don't auto-remove the container at the end (`--keep`). */
  keep?: boolean;
  /** `true` → wait for user confirmation before the teardown step. */
  interactive?: boolean;
  /** Inject a fixed clock (tests). */
  now?: Date;
  /** Override the output adapter (tests). */
  output?: Output;
  /** Override the confirm prompt (tests). */
  confirm?: () => Promise<void>;
}

export interface RunScenarioResult {
  ok: boolean;
  containerName: string;
  durationMs: number;
  error?: Error;
}

/**
 * Drive a single scenario end-to-end. Catches errors and returns them
 * structured — the caller (commands/run.ts) decides what to do with
 * a failed run (continue with the next, exit non-zero, …).
 */
export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOptions = {},
): Promise<RunScenarioResult> {
  const out = opts.output ?? makeOutput();
  const name = scenarioContainerName(
    scenario.id,
    opts.now ? { now: opts.now } : {},
  );
  const start = Date.now();

  out.info(
    `Scenario \`${scenario.id}\` (≈${scenario.estimatedSeconds}s) — container \`${name}\``,
  );

  const ctx: ScenarioCtx = {
    name,
    cli: (args) => run(args),
    cliCapture: (args) => capture(args, { allowNonZero: true }),
    step: (label) => out.step(label),
    info: (msg) => out.info(msg),
    assert: (cond, msg) => {
      if (!cond) throw new Error(msg);
    },
  };

  try {
    await scenario.run(ctx);
    const durationMs = Date.now() - start;

    if (opts.interactive) {
      out.info(
        `Scenario \`${scenario.id}\` finished. Container \`${name}\` is still up — press Enter to tear it down (Ctrl+C to keep it).`,
      );
      const confirm = opts.confirm ?? waitForEnter;
      await confirm();
    }

    if (!opts.keep) {
      await teardown(name, out);
    } else {
      out.info(
        `Container \`${name}\` left running (--keep). Tear down with: monoceros remove ${name} --no-backup --yes`,
      );
    }

    return { ok: true, containerName: name, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err : new Error(String(err));
    out.error(
      `Scenario \`${scenario.id}\` failed after ${(durationMs / 1000).toFixed(1)}s: ${error.message}`,
    );
    out.info(
      `Container \`${name}\` is left running for inspection. Tear down with: monoceros remove ${name} --no-backup --yes`,
    );
    return { ok: false, containerName: name, durationMs, error };
  }
}

async function teardown(name: string, out: Output): Promise<void> {
  out.step(`Teardown — remove ${name}`);
  const start = Date.now();
  try {
    await run(['remove', name, '--no-backup', '--yes'], {
      allowNonZero: true,
    });
    out.pass(`Teardown — remove ${name}`, Date.now() - start);
  } catch (err) {
    out.fail(
      `Teardown — remove ${name}`,
      err instanceof Error ? err : new Error(String(err)),
      Date.now() - start,
    );
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

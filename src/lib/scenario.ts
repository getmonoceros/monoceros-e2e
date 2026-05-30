import { existsSync } from 'node:fs';
import path from 'node:path';
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
  /**
   * Wraps `fn` in a step block: prints a start marker, runs the body,
   * then a PASS marker with timing — or a FAIL marker + re-throw on
   * error. The scenario's body composes from these so the output has
   * clear brackets around each phase.
   */
  step: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Free-form info line between or inside steps. */
  info: (msg: string) => void;
  /**
   * Assertion with a visible „passed" marker. On true: prints an
   * indented `✓ <label>` line. On falsy: throws
   * `Expectation failed: <label>` with optional `details` appended.
   *
   * Phrased as expectations (positive: „stdout matches semver"), not
   * failure messages — the same string makes sense in both directions.
   */
  expect: (label: string, cond: unknown, details?: string) => void;
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
    step: async (label, fn) => {
      out.stepStart(label);
      const stepStart = Date.now();
      try {
        const result = await fn();
        out.stepPass(label, Date.now() - stepStart);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        out.stepFail(label, e, Date.now() - stepStart);
        throw e;
      }
    },
    info: (msg) => out.info(msg),
    expect: (label, cond, details) => {
      if (cond) {
        out.check(label);
        return;
      }
      const detail = details ? ` (${details})` : '';
      throw new Error(`Expectation failed: ${label}${detail}`);
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
      await teardown(ctx, name);
    } else {
      out.info(
        `Container \`${name}\` left running (--keep). Tear down with: monoceros remove ${name} --no-backup --yes`,
      );
    }

    out.summary({
      scenarioId: scenario.id,
      ok: true,
      durationMs,
      containerName: name,
    });
    return { ok: true, containerName: name, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err : new Error(String(err));
    out.info(
      `Container \`${name}\` is left running for inspection. Tear down with: monoceros remove ${name} --no-backup --yes`,
    );
    out.summary({
      scenarioId: scenario.id,
      ok: false,
      durationMs,
      containerName: name,
      errorMessage: error.message,
    });
    return { ok: false, containerName: name, durationMs, error };
  }
}

async function teardown(_ctx: ScenarioCtx, name: string): Promise<void> {
  // Some scenarios call `monoceros remove` themselves as part of
  // the test body (e.g. image-mode-zombie). In that case there's
  // nothing left for the framework to clean up — calling remove
  // again would print "Nothing to remove" to stderr, which reads
  // as an ERROR even though the scenario passed. Pre-check by
  // looking for the yml profile: if it's gone, the scenario body
  // already cleaned up and the framework teardown is a no-op.
  const home =
    process.env.MONOCEROS_HOME?.trim() ||
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.monoceros',
    );
  const ymlPath = path.join(home, 'container-configs', `${name}.yml`);
  if (!existsSync(ymlPath)) {
    return;
  }
  // Best-effort cleanup. If `monoceros remove` exits non-zero, the
  // step marker shows ✗ FAILED with the real error — but we catch
  // the throw here so the scenario's overall result isn't flipped
  // by a cleanup hiccup. The tests passed; the aftermath had issues
  // worth surfacing, not worth retracting the result. Pre-Flight on
  // the next run mops up what the framework couldn't.
  //
  // Common Linux quirk this catches: postgres service writes
  // /var/lib/postgresql as root (its container UID), the host's
  // bind-mount mirrors those permissions, and the unprivileged
  // monoceros remove can't rmdir the data/postgres/ tree. The step
  // shows ✗ FAILED with the EACCES line, the maintainer sees it,
  // the test result stays honest.
  try {
    await _ctx.step(`Teardown — remove ${name}`, () =>
      run(['remove', name, '--no-backup', '--yes']),
    );
  } catch {
    /* stepFail already printed the error */
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

import { defineCommand } from 'citty';
import { consola } from 'consola';
import { detectMonoceros } from '../lib/cli.js';
import { preflightCleanup } from '../lib/cleanup.js';
import { runScenario, type RunScenarioOptions } from '../lib/scenario.js';
import {
  findScenario,
  listScenarioIds,
  SCENARIOS,
} from '../scenarios/index.js';

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run one or more E2E scenarios against the locally installed `monoceros`. Pre-flight cleanup removes any leftover e2e-* containers/yml profiles from previous runs.',
  },
  args: {
    scenario: {
      type: 'positional',
      description:
        'Scenario id (see `monoceros-e2e list`). Omit together with --all.',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Run every registered scenario sequentially.',
      default: false,
    },
    keep: {
      type: 'boolean',
      description: 'Do not remove the container after the asserts pass.',
      default: false,
    },
    interactive: {
      type: 'boolean',
      description: 'Pause for confirmation before tearing the container down.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.all && !args.scenario) {
      consola.error(
        'No scenario given. Pass an id (e.g. `monoceros-e2e run minimal`) or `--all`.',
      );
      consola.info(`Available scenarios: ${listScenarioIds().join(', ')}`);
      process.exit(1);
    }
    if (args.all && args.scenario) {
      consola.error('Pass either a scenario id OR --all, not both.');
      process.exit(1);
    }

    const version = await detectMonoceros();
    if (version === null) {
      consola.error(
        'Could not find `monoceros` on PATH. Install the workbench first: https://github.com/getmonoceros/workbench#installation',
      );
      process.exit(1);
    }
    consola.info(`Detected monoceros ${version}.`);

    await preflightCleanup();

    const opts: RunScenarioOptions = {
      keep: args.keep,
      interactive: args.interactive,
    };

    if (args.all) {
      const results: Array<{ id: string; ok: boolean; durationMs: number }> =
        [];
      for (const scenario of SCENARIOS) {
        const result = await runScenario(scenario, opts);
        results.push({
          id: scenario.id,
          ok: result.ok,
          durationMs: result.durationMs,
        });
      }
      const failed = results.filter((r) => !r.ok);
      consola.box(
        `${results.length - failed.length}/${results.length} scenarios passed`,
      );
      if (failed.length > 0) {
        for (const f of failed) consola.fail(f.id);
        process.exit(1);
      }
      return;
    }

    const scenario = findScenario(args.scenario!);
    if (!scenario) {
      consola.error(
        `Unknown scenario '${args.scenario}'. Known: ${listScenarioIds().join(', ')}`,
      );
      process.exit(1);
    }
    const result = await runScenario(scenario, opts);
    if (!result.ok) process.exit(1);
  },
});

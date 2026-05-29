import { defineCommand } from 'citty';
import { consola } from 'consola';
import { SCENARIOS } from '../scenarios/index.js';

export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List the available E2E scenarios.',
  },
  async run() {
    if (SCENARIOS.length === 0) {
      consola.info('No scenarios registered.');
      return;
    }
    const isTty = (process.stdout.isTTY ?? false) === true;
    const idWidth = Math.max(...SCENARIOS.map((s) => s.id.length));
    for (const s of SCENARIOS) {
      const id = s.id.padEnd(idWidth);
      const eta = `~${s.estimatedSeconds}s`;
      if (isTty) {
        process.stdout.write(`  ${id}  ${eta.padEnd(6)}  ${s.description}\n`);
      } else {
        process.stdout.write(
          `${s.id}\t${s.estimatedSeconds}\t${s.description}\n`,
        );
      }
    }
  },
});

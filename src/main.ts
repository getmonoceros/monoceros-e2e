import { defineCommand } from 'citty';
import { listCommand } from './commands/list.js';
import { runCommand } from './commands/run.js';
import { E2E_VERSION } from './version.js';

export const main = defineCommand({
  meta: {
    name: 'monoceros-e2e',
    version: E2E_VERSION,
    description:
      'End-to-end scenarios for the Monoceros workbench. Drives a real `monoceros` installation through curated lifecycle flows on the real builder machine. Maintainer tool — not part of the builder surface.',
  },
  subCommands: {
    list: listCommand,
    run: runCommand,
  },
});

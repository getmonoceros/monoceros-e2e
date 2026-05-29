import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Build configuration for the published `@getmonoceros/e2e` npm
// package. ESM only — mirrors the workbench CLI build. Version comes
// from package.json at build time and replaces `__E2E_VERSION__` in
// src/version.ts; single source of truth for the version.

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(
  readFileSync(path.join(here, 'package.json'), 'utf8'),
).version as string;

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  shims: false,
  splitting: false,
  noExternal: [],
  define: {
    __E2E_VERSION__: JSON.stringify(pkgVersion),
  },
});

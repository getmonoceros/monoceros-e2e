// The string below is rewritten by tsup at build time (see
// tsup.config.ts → define.__E2E_VERSION__). At dev time (tsx,
// vitest) the fallback constant is what `monoceros-e2e --version`
// reports — keep it loose-enough so the dev experience doesn't lie
// about a release that hasn't shipped.
declare const __E2E_VERSION__: string;

export const E2E_VERSION: string =
  typeof __E2E_VERSION__ === 'string' ? __E2E_VERSION__ : '0.0.0-dev';

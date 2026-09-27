import type { Scenario, ScenarioCtx } from '../lib/scenario.js';

/**
 * `with-browser` — the browser feature (workbench ADR 0060): a headless
 * Chromium from Debian plus the Playwright MCP server, registered with the
 * agent by apply because the feature carries it, not because the yml names it.
 *
 * Both halves float to latest by design, so this is the upstream canary for
 * them. What it proves, in the order a builder depends on it:
 *
 *   1. Chromium runs headless on this runner's architecture. The feature's
 *      install.sh already starts it once at build time; asserting it here too
 *      keeps a silent install.sh change from passing.
 *   2. apply wrote the `playwright` server into Claude Code's config with no
 *      `mcpServers:` entry in the yml.
 *   3. The server, started exactly as the agent would start it (command and
 *      args read back from `~/.claude.json`), drives a real page on
 *      `localhost`: the snapshot shows the heading, a click fires a request,
 *      and the console and network tools report it. An upstream change to the
 *      tool names the briefing uses fails here instead of in a builder's run.
 *   4. It writes nothing into the workspace, which is the builder's repo.
 *   5. A project's own `@playwright/test` runs, after the one
 *      `npx playwright install --only-shell chromium` the docs tell builders
 *      to run, without `--with-deps`.
 *
 * No agent login is needed: the server is driven over stdio by a small MCP
 * client in the container, not through Claude.
 */
export const withBrowser: Scenario = {
  id: 'with-browser',
  description:
    'init → apply (claude, browser) → chromium runs, playwright MCP registered and drives a localhost page, project Playwright test passes → remove',
  estimatedSeconds: 240,
  async run(ctx) {
    await ctx.step(`init ${ctx.name} --with-features=claude,browser`, () =>
      ctx.cli(['init', ctx.name, '--with-features=claude,browser']),
    );

    await ctx.step(`apply ${ctx.name}`, () =>
      ctx.cli(['apply', ctx.name, '--yes']),
    );

    await ctx.step('chromium runs headless', () =>
      assertOk(
        ctx,
        'chromium',
        'chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null',
      ),
    );

    await ctx.step('playwright MCP registered for Claude Code', () =>
      assertOk(
        ctx,
        'playwright registration',
        'jq -e \'.mcpServers.playwright.command == "playwright-mcp"\' ~/.claude.json',
      ),
    );

    await ctx.step('playwright MCP drives a localhost page', () =>
      assertOk(ctx, 'playwright MCP canary', mcpCanary(ctx.name)),
    );

    await ctx.step("the project's own Playwright test passes", () =>
      assertOk(ctx, 'project Playwright test', projectTest()),
    );
  },
};

/** A page with a heading, a button that fetches, and a console line. */
const PAGE = [
  '<!doctype html><html><head><title>E2E App</title></head><body>',
  '<h1>Hello from the workbench</h1>',
  "<button onclick=\"document.querySelector('h1').textContent='Clicked'; fetch('/ping').then(r=>r.text()).then(t=>console.log('ping:'+t))\">Click me</button>",
  '</body></html>',
].join('\n');

/** Write the page and serve it on localhost:5173 in the background. */
function servePage(dir: string): string[] {
  return [
    `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir}`,
    `cat > index.html <<'PAGE'\n${PAGE}\nPAGE`,
    'echo pong > ping',
    'python3 -m http.server 5173 >/dev/null 2>&1 &',
    'SERVER_PID=$!',
    "trap 'kill $SERVER_PID 2>/dev/null' EXIT",
    'for _ in $(seq 1 20); do curl -fsS http://localhost:5173/ >/dev/null 2>&1 && break; sleep 0.5; done',
  ];
}

/**
 * A minimal MCP stdio client: initialize, then navigate, snapshot, click the
 * button by the ref the snapshot gave it, and read console and network. It
 * exits non-zero with the reason when any expectation fails.
 *
 * The click passes the ref as both `ref` and `target`: the argument was
 * renamed upstream once already, and what this canary guards is the tool
 * names the briefing tells agents to use, not the shape of their arguments,
 * which an agent reads from the schema.
 */
const MCP_CLIENT = String.raw`
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const reg = JSON.parse(readFileSync(homedir() + '/.claude.json', 'utf8')).mcpServers.playwright;
const proc = spawn(reg.command, reg.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 0;
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch {}
  }
});
const fail = (why) => { console.error('FAIL: ' + why); proc.kill(); process.exit(1); };
const rpc = (method, params) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  setTimeout(() => fail('timeout on ' + method + ' ' + (params?.name ?? '')), 90000);
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.error || r.result?.isError) fail(name + ': ' + (r.error?.message ?? text));
  return text;
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
for (const t of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_console_messages', 'browser_network_requests']) {
  if (!tools.includes(t)) fail('tool ' + t + ' is gone; the briefing names it. Tools: ' + tools.join(' '));
}
await call('browser_navigate', { url: 'http://localhost:5173/' });
const snap = await call('browser_snapshot', {});
if (!snap.includes('Hello from the workbench')) fail('snapshot has no heading: ' + snap);
const ref = /button "Click me" \[ref=([^\]]+)\]/.exec(snap)?.[1];
if (!ref) fail('snapshot has no button ref: ' + snap);
await call('browser_click', { element: 'Click me button', ref, target: ref });
await new Promise((r) => setTimeout(r, 1000));
const consoleText = await call('browser_console_messages', { level: 'info' });
if (!consoleText.includes('ping:pong')) fail('console has no ping:pong: ' + consoleText);
const network = await call('browser_network_requests', {});
if (!/\/ping => \[200\]/.test(network)) fail('network has no 200 for /ping: ' + network);
console.log('playwright MCP canary passed');
proc.kill();
process.exit(0);
`;

function mcpCanary(name: string): string {
  return [
    'set -e',
    ...servePage('/tmp/e2e-browser'),
    `cat > client.mjs <<'CLIENT'\n${MCP_CLIENT}\nCLIENT`,
    // From the workspace, where the agent runs: the server's default output
    // directory would be relative to it.
    `cd /workspaces/${name}`,
    'node /tmp/e2e-browser/client.mjs',
    `if [ -e /workspaces/${name}/.playwright-mcp ]; then echo "FAIL: .playwright-mcp written into the workspace" >&2; exit 1; fi`,
  ].join('\n');
}

const SPEC = [
  "import { test, expect } from '@playwright/test';",
  "test('click updates heading', async ({ page }) => {",
  "  await page.goto('http://localhost:5173/');",
  "  await page.getByRole('button', { name: 'Click me' }).click();",
  "  await expect(page.getByRole('heading')).toHaveText('Clicked');",
  '});',
].join('\n');

function projectTest(): string {
  return [
    'set -e',
    ...servePage('/tmp/e2e-browser-project'),
    'mkdir -p tests',
    `cat > tests/app.spec.ts <<'SPEC'\n${SPEC}\nSPEC`,
    'npm init -y >/dev/null',
    'npm install --no-audit --no-fund --silent @playwright/test >/dev/null',
    'npx playwright install --only-shell chromium >/dev/null',
    'npx playwright test --reporter=line',
  ].join('\n');
}

async function assertOk(
  ctx: ScenarioCtx,
  label: string,
  cmd: string,
): Promise<void> {
  const result = await ctx.cliCapture([
    'run',
    ctx.name,
    '--',
    'bash',
    '-c',
    cmd,
  ]);
  ctx.expect(
    `${label} exits 0`,
    result.exitCode === 0,
    `exit ${result.exitCode}: ${(result.stderr.trim() || result.stdout.trim()).slice(-600)}`,
  );
}

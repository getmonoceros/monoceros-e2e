# Szenario `with-browser`

Verifiziert das `browser`-Feature aus
[Workbench-ADR 0060](https://github.com/getmonoceros/workbench/blob/main/docs/adr/0060-a-feature-can-carry-its-own-mcp-server.md):
ein headless Chromium aus Debian plus der Playwright-MCP-Server, den `apply`
beim Agenten registriert, weil das Feature ihn mitbringt, nicht weil die yml
ihn nennt.

Chromium-Paket und `@playwright/mcp` sind beide ungepinnt. Das Szenario ist
deshalb auch der Upstream-Canary für beide, und auf den GitHub-Runnern der
einzige Lauf auf echtem amd64.

## Was es prüft

1. **`monoceros init <name> --with-features=claude,browser`** und
   **`monoceros apply <name>`**. Kein `mcpServers:`-Eintrag in der yml.
2. **Chromium startet headless**, mit denselben Flags wie der MCP-Server.
3. **`playwright` steht in `~/.claude.json`**, als Command
   `playwright-mcp`.
4. **Der Server steuert eine echte Seite auf `localhost:5173`.** Ein kleiner
   MCP-stdio-Client startet ihn genau so, wie Claude Code es tut (Command und
   Args aus `~/.claude.json`), und prüft:
   - die Tools, die das Briefing nennt, gibt es noch
   - der Snapshot zeigt die Überschrift und liefert die Ref des Buttons
   - der Klick löst einen Request aus: `ping:pong` in der Console,
     `/ping => [200]` in den Netzwerk-Requests
5. **Nichts landet im Workspace** (kein `.playwright-mcp/`), der ist das
   Repo des Builders.
6. **Ein Projekt-eigenes `@playwright/test` läuft**, nach dem einen
   `npx playwright install --only-shell chromium` aus den Docs, ohne
   `--with-deps`.

## Was es _nicht_ prüft

- Dass ein Agent den Server von sich aus benutzt. Das ist Modellverhalten,
  kein Workbench-Vertrag, und bräuchte einen API-Key.
- OpenCode und Rovo Dev. Die Übersetzung pro Agent ist im Workbench
  unit-getestet (`mcp-registration.test.ts`), das Feature ändert daran nichts.

## Voraussetzung

- `monoceros` auf PATH, Workbench mit dem `browser`-Feature.
- Internet-Zugriff (apt, npm, Playwright-Browser-Download).

## Laufzeit

~30 Sekunden mit warmem Feature-Layer. Kalt kommen Chromium (apt) und der
Playwright-Download dazu, rund 2 bis 4 Minuten auf einem Runner.

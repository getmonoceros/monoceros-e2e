# Szenario `with-briefing`

Verifiziert die AI-Tool-Briefing-Pipeline aus
[Workbench-ADR 0014](https://github.com/getmonoceros/workbench/blob/main/docs/adr/0014-ai-tool-briefing-im-workspace-root.md):
`AGENTS.md`, `CLAUDE.md` und `.monoceros/commands.md` werden beim
`apply` an den Container-Workspace-Root geschrieben und sind aus dem
laufenden Container an den erwarteten Pfaden lesbar.

## Was es prüft

In dieser Reihenfolge:

1. **`monoceros init <name> --with-languages=node --with-services=postgres
--with-features=atlassian/rovodev`** schreibt eine yml mit einem
   Service, einer Sprache und der Atlassian-Sub-Komponente, die nur
   Rovo Dev aktiviert (`twg: false`). Beweist init + Schema.
2. **`monoceros apply <name>`** materialisiert Scaffold + Briefing.
3. **Drei Briefing-Dateien existieren** an `/workspaces/<name>/`:
   `AGENTS.md`, `CLAUDE.md`, `.monoceros/commands.md`. Bash-`test -f`
   pro Datei.
4. **Walk-up-Topologie funktioniert**: aus einem gemockten
   `projects/e2e-probe/`-Unterordner sind die Briefing-Dateien via
   `../../…` erreichbar — das ist der Pfad, den Claude Code und
   OpenCode beim Walk-up auch sehen würden.
5. **`AGENTS.md` reflektiert den yml-Stand und das `whenOption`-Gating**:
   - Marker-Block (`<!-- monoceros:begin -->` / `:end`) vorhanden
   - Container-Name substituiert (`monoceros apply <name>` in den
     Erweiterungs-Beispielen)
   - "Node.js" unter `### Languages`
   - postgres-Zeile unter Services (`postgres:5432`)
   - "Atlassian Rovo Dev" present (rovodev-Option an)
   - **NICHT** "Teamwork Graph" (twg-Option aus durch die
     `atlassian/rovodev`-Sub-Komponente)
   - `@.monoceros/commands.md`-Import am Ende
6. **`CLAUDE.md`** ist der `@AGENTS.md`-Import zwischen Markern.
7. **`.monoceros/commands.md`** hat den Header
   `# monoceros — Command reference`, eine `### \`monoceros apply\``-
   Sektion und die Gruppen-Überschrift `## Container lifecycle`.

## Was es _nicht_ prüft

- "Claude Code lädt die Datei tatsächlich" — Claude-internes
  Verhalten, vom CLI-Skript nicht antriggerbar.
- Marker-Preserve beim Re-Apply — durch Unit-Test
  `briefing-write.test.ts` im Workbench-Repo abgedeckt.
- Inhaltliche Variationen bei anderen Feature-Kombinationen — der
  Generator ist im Workbench-Unit-Test breit abgedeckt; das e2e-
  Szenario sichert einen repräsentativen Pfad ab.

## Voraussetzung

- `monoceros` auf PATH, Workbench mit M6.3 (Briefing-Pipeline) — ab
  Commit `c02fb5d` / Release post-1.14.1.
- Docker-Daemon mit Compose v2 (postgres-Service in der yml).
- Internet-Zugriff (Pull des Compose-Postgres-Image).

## Laufzeit

~120 Sekunden auf einem warmen System. Erstaufruf zieht das
postgres-Image (~150 MB); kann 2-3 Minuten dauern.

## Asserts

| #   | Erwartung                                                                  | Quelle              |
| --- | -------------------------------------------------------------------------- | ------------------- |
| 1   | `AGENTS.md`, `CLAUDE.md`, `.monoceros/commands.md` an `/workspaces/<name>` | `test -f` (Bash)    |
| 2   | Walk-up aus `projects/e2e-probe/` über `../../` erfolgreich                | `test -f` (Bash)    |
| 3   | `AGENTS.md` enthält Marker, Container-Name, Node.js, postgres, Rovo Dev    | grep gegen `cat`    |
| 4   | `AGENTS.md` enthält **nicht** "Teamwork Graph" (twg-Gating)                | grep gegen `cat`    |
| 5   | `AGENTS.md` importiert `@.monoceros/commands.md`                           | grep gegen `cat`    |
| 6   | `CLAUDE.md` enthält Marker + `@AGENTS.md`                                  | grep gegen `cat`    |
| 7   | `.monoceros/commands.md` Header + apply-Sektion + Lifecycle-Gruppe         | grep gegen `cat`    |

## Warum dieses Szenario

CLI-seitige Unit-Tests beweisen, dass die Dateien auf der Host-Disk
landen und ihre Generator-Logik korrekt ist. Was sie **nicht**
beweisen:

- Dass die Dateien beim laufenden Container an den **realen
  In-Container-Pfaden** liegen — `/workspaces/<name>/` setzt voraus,
  dass die Workbench den Container-Verzeichnis-Mount korrekt
  konfiguriert.
- Dass die `manifests:sync`-Bündelung im npm-Tarball funktioniert —
  in der Workbench-Test-Suite löst der Manifest-Loader die Dev-
  Checkout-Pfade auf, in Prod muss der `<workbenchRoot>/features/`-
  Bundle-Pfad greifen, sonst fehlt das `whenOption`-Gating.

Beides Lücken, die dieses Szenario schließt — mit einer einzelnen
end-to-end-apply-Strecke ohne Repo-Clone oder Web-Probe.

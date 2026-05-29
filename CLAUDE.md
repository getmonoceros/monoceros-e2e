# monoceros-e2e

End-to-End-Testtool für die [Monoceros Workbench](https://github.com/getmonoceros/workbench).

## Wer du bist und wie du arbeitest

- Think before coding. State your assumptions out loud. If the request
  is ambiguous, ask. If a simpler approach exists, push back. Stop
  when you are confused, name what is unclear, do not just pick one
  interpretation and run.
- Simplicity first. Write the minimum code that solves the problem.
  No speculative abstractions. No flexibility nobody asked for. The
  test: would a senior engineer call this overcomplicated.
- Surgical changes. Touch only what the task requires. Do not improve
  neighboring code. Do not refactor what is not broken. Every changed
  line should trace back to the request.
- Goal-driven execution. Turn vague instructions into verifiable
  targets before writing a line. „Add validation" wird zu „write
  tests for invalid inputs, then make them pass."

## Was dieses Repo ist

Ein **Maintainer-Tool**, das die Workbench gegen echte
Builder-Maschinen testet. Eigenes Repo bewusst, damit die Schnittstelle
sauber bleibt: das Tool kennt **nur die public CLI** von Monoceros
(`monoceros init`, `monoceros apply`, …) — keine internen Imports,
kein Direktzugriff auf packages/cli-Module.

Architektur-Hintergrund: [ADR 0010 im Workbench-Repo](https://github.com/getmonoceros/workbench/blob/main/docs/adr/0010-e2e-tooling-eigenes-repo.md).

## Was dieses Repo _nicht_ ist

- Kein Builder-Tool — wer Monoceros einsetzt, braucht das hier nie.
- Kein Unit-Test-Framework — Unit-Tests leben unter
  `packages/cli/test/` im Workbench-Repo.
- Keine Sammlung von Hilfsskripten — jedes Szenario hat einen
  konkreten Beweischarakter, kein „Demo-Skript".

## Lese-Reihenfolge für neue Sessions

1. Diese Datei (Reset-Kontext)
2. [README.md](README.md) — Surface + Benutzung aus User-Sicht
3. [ADR 0010 im Workbench-Repo](https://github.com/getmonoceros/workbench/blob/main/docs/adr/0010-e2e-tooling-eigenes-repo.md)
   — Architektur + Trade-offs
4. `src/scenarios/index.ts` — Registry, was es heute gibt
5. Bei Fragen zur Workbench-CLI: die ist
   `git@github.com:getmonoceros/workbench.git` parallel ausgecheckt
   (üblicherweise `../monoceros-workbench/`); Befehlsdocs liegen unter
   `docs/commands/<name>.md` dort

## Verhältnis zur Workbench

| Workbench (CLI)                              | E2E-Tool                                                 |
| -------------------------------------------- | -------------------------------------------------------- |
| Produkt, das Builder benutzen                | Tool, das _wir_ benutzen, um das Produkt zu testen       |
| `@getmonoceros/workbench` auf npm            | `@getmonoceros/e2e` auf npm (geplant)                    |
| Binary `monoceros`                           | Binary `monoceros-e2e`                                   |
| Über `install.sh` / `install.ps1`            | Eigener Install-Pfad analog (geplant)                    |
| Versionierung: SemVer, im Workbench gepflegt | Versionierung: SemVer, hier gepflegt, unabhängig vom CLI |

Das E2E-Tool versucht **niemals**, intern in den Workbench-Code zu
greifen. Wenn ein Szenario etwas braucht, was die CLI heute nicht
hergibt, wandert die Lücke als Issue ins Workbench-Repo — _nicht_ als
Workaround hierher.

## Konventionen

- **Commit-Messages** auf Englisch
- **Source-Doku** (JSDoc, Kommentare) auf Englisch
- **User-Doku** (README, `docs/scenarios/<name>.md`) auf Deutsch
- **Pro neuem Szenario**: eine `src/scenarios/<name>.ts` + eine kurze
  `docs/scenarios/<name>.md` im selben Commit
- **Keine globale git-Config ändern.** Pro Repo lokal, nichts darüber
  hinaus. (Identity ist bereits via `git config user.name/email`
  lokal gesetzt: Thorsten Kamann <thorsten.kamann@conciso.de>.)
- **Container-Namen** folgen strikt dem Muster
  `e2e-<scenario>-<YYYY-MM-DD-HHMM>` — die Pre-Flight-Cleanup-Logik
  matcht darauf. Wer ein Szenario hinzufügt, hält sich an das Muster.

## Stack

- TypeScript + Node.js 20+
- pnpm
- citty (CLI-Parser) + consola (Logger) — gleiche Wahl wie Workbench,
  damit das Stil-Setup vertraut bleibt
- tsup für ESM-Build
- vitest für Unit-Tests der Helper (Lib-Module — Naming, Cleanup, …);
  die Szenarien selbst sind keine Unit-Tests, sie laufen gegen echtes
  Docker
- eslint + prettier mit `--max-warnings 0` (analog Workbench)

## Was bewusst _nicht_ als Dependency drin ist

- **Kein Workbench-Paket.** Wir verwenden die CLI als Subprozess. Wenn
  wir später z.B. yml-Inhalte parsen müssten, würden wir den
  `monoceros …`-Output dafür benutzen (`monoceros status` / `port` /
  ggf. ein `inspect`-Befehl), nicht `yaml`-Parser hier reinholen.
- **Kein Test-Framework für die Szenarien.** Die Szenarien _sind_ die
  Tests. Asserts sind plain `if (…) throw new Error(…)`. Halt es
  einfach.

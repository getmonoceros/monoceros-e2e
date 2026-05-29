# monoceros-e2e

End-to-End-Szenarien für die [Monoceros Workbench](https://github.com/getmonoceros/workbench).
**Maintainer-Tool**, kein Builder-Tool — es treibt eine echte
Monoceros-Installation auf deiner realen Builder-Maschine durch
definierte Lifecycle-Strecken (`init → apply → run → remove`,
Port-Routing, Tunnel, …) und prüft, dass die Surface tut, was sie
verspricht.

Hintergrund + Architektur-Entscheidung:
[ADR 0010](https://github.com/getmonoceros/workbench/blob/main/docs/adr/0010-e2e-tooling-eigenes-repo.md)
im Workbench-Repo.

## Was es _nicht_ ist

- Kein Unit-Test — die liegen unter `packages/cli/test/` im
  Workbench-Repo.
- Kein CI-Matrix-Sweep — die OS-spezifischen Bugs, die wir wirklich
  fangen wollen, treten auf echten Builder-Maschinen auf, nicht auf
  GitHub-Hosted-Runnern.
- Keine offizielle Builder-Surface — wer Monoceros einsetzt, braucht
  das hier nie. Nur wer am Tooling arbeitet.

## Voraussetzung

Eine funktionierende Monoceros-Installation auf der Maschine, auf der
das Tool läuft:

```sh
monoceros --version
# → 1.10.0  (oder neuer)
```

Falls noch nicht: siehe [Workbench-Install](https://github.com/getmonoceros/workbench#installation).

## Installation

Mittelfristig: `install.sh` / `install.ps1`-Bouncer analog zur
Workbench, sobald `@getmonoceros/e2e` veröffentlicht ist —
ein Aufruf, gleiche UX wie der Workbench-Installer.

Solange das Repo nur lokal lebt, läuft das Tool direkt aus dem
Checkout:

```sh
git clone https://github.com/getmonoceros/monoceros-e2e.git
cd monoceros-e2e
pnpm install
pnpm build
# Aufruf direkt:
node dist/bin.js list
# oder Dev-Mode mit tsx (kein Build nötig):
pnpm start list
```

## Benutzung

Verfügbare Szenarien anzeigen:

```sh
monoceros-e2e list
```

Ein einzelnes Szenario laufen lassen:

```sh
monoceros-e2e run minimal
```

Alle Szenarien sequenziell:

```sh
monoceros-e2e run --all
```

Container nach dem Lauf stehenlassen (für manuelle Inspektion):

```sh
monoceros-e2e run minimal --keep
```

Auf Bestätigung warten, bevor der Teardown läuft:

```sh
monoceros-e2e run minimal --interactive
```

## Aufräum-Modell

Jedes Szenario legt einen Container an, dessen Name dem Muster
`e2e-<scenario>-<YYYY-MM-DD-HHMM>` folgt (z.B.
`e2e-minimal-2026-05-28-1830`).

**Vor jedem Lauf** (egal welches Szenario, egal ob via `--all`) räumt
das Tool stehengebliebene Container aus früheren Runs ab:

1. Alle yml-Profile mit Präfix `e2e-` werden via
   `monoceros remove --no-backup --yes <name>` weggeräumt.
2. Als Notbremse — falls die yml schon weg, der Container aber noch
   lebt: `docker ps -aq --filter "name=^e2e-"` → `docker rm -f`.

Dadurch ist Ctrl+C jederzeit unkritisch. Was stehenbleibt, wird
spätestens beim nächsten Aufruf weggeräumt.

## Surface über `monoceros`

Wenn der Workbench-seitige Plugin-Dispatch installiert ist (Sub-Tasks
4.1-4.3 im Workbench-Backlog), kannst du das Tool auch über
`monoceros e2e …` ansprechen — `monoceros` dispatcht dann nach
`monoceros-e2e` im PATH:

```sh
monoceros e2e list
monoceros e2e run minimal --keep
```

Funktional identisch — eine Surface, ein Mental-Model.

## CI-Integration

GH-Actions-Workflow läuft auf `ubuntu-latest`, führt nur das
`minimal`-Szenario als Smoketest aus. Bei `GITHUB_ACTIONS=true` schaltet
das Tool das Output-Format auf GH-Annotations (`::notice::` /
`::error::`-Marker), die im PR-UI als Inline-Marker auftauchen.

macOS und Windows bleiben manuelle Strecken — auf den
realen Builder-Maschinen, nicht auf Runnern.

## Konventionen

- **Commit-Messages** auf Englisch
- **Source-Doku** (Kommentare, JSDoc) auf Englisch
- **User-Doku** (dieses README, etwaige Szenarien-Beschreibungen) auf
  Deutsch — gleiche Sprache wie das Workbench-Doc-Set
- **Pro neuem Szenario**: kurze Beschreibung in `docs/scenarios/<name>.md`
  (was es prüft, was es voraussetzt, geschätzte Laufzeit)
- Das Tool nutzt **ausschließlich** die public CLI von Monoceros (`monoceros …`).
  Keine Imports aus dem Workbench-Repo. Was im Tool steht, könnte ein
  Builder auch tun.

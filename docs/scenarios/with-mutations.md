# Szenario `with-mutations`

Realistische „Builder baut Container Stück für Stück auf"-Strecke.
Nach dem initialen Apply werden zwei konfigurationsverändernde
Befehle hintereinander gefeuert, dann einmal re-applyed, dann
verifiziert.

## Was es prüft

1. **`monoceros init <name> --with-languages=node`** + **`apply`** — Baseline-
   Container hochgefahren.
2. **`monoceros add-apt-packages <name> -- jq`** — yml-Mutation für
   apt-Pakete (mehrfach komma-separiert möglich, aber wir prüfen
   den einfachsten Fall).
3. **`monoceros add-feature <name> github`** — Devcontainer-Feature
   für `gh` (GitHub CLI). Das ist die gleiche Mechanik, mit der
   Claude Code und die Atlassian-Tools ausgeliefert werden — wenn
   das hier durchgeht, ist die kritische Lieferinfrastruktur okay.
4. **`monoceros apply <name>`** noch einmal — Devcontainer-Features
   brauchen einen Rebuild, apt-Pakete sind im post-create-Pfad
   ohnehin Teil der Strecke.
5. **`monoceros run <name> -- jq --version`** muss `jq-<MAJOR>.<MINOR>`
   liefern.
6. **`monoceros run <name> -- gh --version`** muss `gh version
<MAJOR>.<MINOR>.<PATCH>` liefern.

## Warum kombiniert?

Zwei separate Einzel-Szenarien (`add-apt-packages`, `add-feature`)
würden jeweils einen vollen Container-Lifecycle (init → apply →
mutate → apply → verify → remove) abspulen. Das ist Doppel-
Aufwand für sehr ähnliche Mechanik. Die kombinierte Strecke prüft
beides mit einem einzigen Re-apply, und sie spiegelt das _reale_
Builder-Verhalten: mehrere `add-*` Aufrufe, dann ein Apply.

Wenn einer der beiden Asserts versagt, ist die Failure-Lokalisierung
klar — der jeweilige Verifizierungs-Step hat einen eindeutigen Tag
(`jq --version` vs `gh --version`).

## Voraussetzung

- `monoceros` auf PATH.
- Docker-Daemon.
- Internet-Zugriff (apt-Repos für jq, OCI-Pull für das github-cli-
  Feature).

## Laufzeit

~180 Sekunden. Der zweite Apply ist der teuerste Schritt — Feature-
Install holt das devcontainer-Feature-Image, baut die Schicht.

## Asserts

| #   | Erwartung                                       |
| --- | ----------------------------------------------- |
| 1   | `jq --version` exits 0                          |
| 2   | stdout matcht `jq-<MAJOR>.<MINOR>`              |
| 3   | `gh --version` exits 0                          |
| 4   | erste stdout-Zeile matcht `gh version <SEMVER>` |

# Szenario `minimal`

Der schmälste sinnvolle Lifecycle-Beweis.

## Was es prüft

- `monoceros init <name> --with-languages=node` schreibt die yml.
- `monoceros apply <name>` fährt einen Image-Mode-Container hoch
  (keine Compose-Services).
- `monoceros run <name> -- node --version` zeigt, dass das Workspace-
  Image Node mitbringt und Run-Befehle funktionieren.
- `monoceros remove <name>` räumt yml + Container weg.

## Was es _nicht_ prüft

- Keine Compose-Services (das macht `with-services`).
- Kein Port-Routing (das macht `with-port`).
- Kein Tunnel (das macht `with-tunnel`).
- Kein Zombie-Check für Image-Mode-Container (das macht
  `image-mode-zombie`).

## Voraussetzung

- `monoceros` auf PATH, Version 1.10.0 oder neuer.
- Docker-Daemon läuft.

## Laufzeit

~60 Sekunden auf einem warmen System (das Workbench-Runtime-Image
ist bereits gepullt). Erstaufruf kann mehrere Minuten dauern, weil
das Image gezogen wird.

## Asserts

- `monoceros run … node --version` exited mit 0.
- stdout matcht `^v\d+\.\d+\.\d+` (Node-Versionsstring).

Falls die Asserts fehlschlagen, lässt das Tool den Container stehen
(siehe README → „Aufräum-Modell") — der Maintainer kann via
`monoceros shell <name>` reinschauen.

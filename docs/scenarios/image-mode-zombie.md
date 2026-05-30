# Szenario `image-mode-zombie`

Regression-Guard für den M4-Task-9-Fund.

## Hintergrund

Image-Mode-Dev-Container (kein Compose — z. B. nur `--with=node`)
sind früher nach `monoceros remove` als Zombies in `docker ps -a`
übriggeblieben. Ursache: die `remove`-Pipeline hat ausschließlich
über das Label `com.docker.compose.project` gefiltert, das es bei
plain-`docker run`-Containern gar nicht gibt. Der Fix nutzt
zusätzlich das Label `devcontainer.local_folder`, das
`@devcontainers/cli` auf JEDEN Container schreibt — Image-Mode
genauso wie Compose-Mode. Dieses Szenario hält den Fix ehrlich.

## Was es prüft

1. **`monoceros init <name> --with=node`** — strikt Image-Mode,
   keine Services.
2. **`monoceros apply <name>`** — Container läuft.
3. **Sanity-Check**: `docker ps -aq --filter
label=devcontainer.local_folder=<container-dir>` liefert
   mindestens eine ID (damit der eigentliche Test nicht ins Leere
   greift).
4. **`monoceros remove <name> --no-backup --yes`**.
5. **Regression-Assert**: der gleiche `docker ps -aq`-Filter
   liefert **keinen** Container mehr — running oder stopped.

## Voraussetzung

- `monoceros` auf PATH.
- Docker-Daemon.

## Laufzeit

~90 Sekunden auf einem warmen System.

## Asserts

| #   | Erwartung                                               |
| --- | ------------------------------------------------------- |
| 1   | nach `apply`: >= 1 Container mit dem local_folder-Label |
| 2   | nach `remove`: 0 Container mit dem local_folder-Label   |

## Warum gerade dieser Test

Es wäre verlockend, das im Workbench-Repo als Unit-Test zu
modellieren — aber die echte Mechanik (Container wird angelegt,
Container muss weg) verlangt einen echten Docker-Daemon. Genau
dafür gibt es das E2E-Tool. Wenn jemand die `remove`-Pipeline
umbaut und das Label-Anchor versehentlich entfernt, fängt dieses
Szenario es ab, bevor ein Builder einen Container-Friedhof sammelt.

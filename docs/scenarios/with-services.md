# Szenario `with-services`

Compose-Mode mit einem Postgres-Service-Container.

## Was es prüft

- `monoceros init <name> --with=node,postgres` schreibt eine yml mit
  `services: [postgres]`.
- `monoceros apply <name>` materialisiert das als Compose-Profil und
  fährt workspace + postgres hoch.
- Vom Workspace-Container aus ist postgres unter dem Compose-Service-
  Namen `postgres:5432` erreichbar — also funktioniert das Compose-
  Default-Netzwerk und die DNS-Auflösung zwischen Services.
- `monoceros remove <name>` räumt Compose-Stack, das `data/postgres/`-
  Bind-Mount und yml ab.

## Was es _nicht_ prüft

- Keine SQL-Roundtrips — das würde `psql` im Workspace-Image
  voraussetzen. TCP-Reachability ist die baseline-Aussage, die zählt.
- Keine Persistenz über Container-Restarts (separate Sache; gehört
  in ein potenzielles `services-persistence`-Szenario, falls je
  gebraucht).

## Voraussetzung

- `monoceros` auf PATH, Compose-Mode-Support (Workbench 1.0+).
- Docker-Daemon mit Compose v2.

## Laufzeit

~120 Sekunden auf einem warmen System. Erstaufruf zieht das postgres-
Image (~150 MB) — kann beim allerersten Mal 2-3 Minuten dauern.

## Asserts

- `</dev/tcp/postgres/5432` erfolgreicher TCP-Connect aus dem
  Workspace, innerhalb von 30 Sekunden ab `apply`-Ende. Wir geben
  dem Postgres-Container Zeit, sich zu initialisieren (typisch
  5-15 s); ein Bash-Retry-Loop im Workspace probiert sekündlich.

## Aufbau der TCP-Probe

Ein einzelner `monoceros run`-Aufruf mit einem Bash-Retry-Loop im
Container. Würden wir pro Versuch ein neues `monoceros run` starten,
würde der devcontainer-cli-Overhead pro Versuch 1-2 Sekunden kosten.
Bash-builtin `</dev/tcp/host/port` braucht keinen externen Client.

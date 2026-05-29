# Szenario `add-repo`

Beweist den **on-the-fly Clone-Pfad** von `monoceros add-repo` —
unterschiedlich zum init-time-Clone via `--with-repo`, den
`with-services` und `with-port` schon abdecken.

## Was es prüft

1. **`monoceros init <name> --with=node`** ohne `--with-repo` —
   reiner Image-Mode-Container, kein Repo in der yml.
2. **`monoceros apply <name>`** fährt den Container hoch.
3. **`monoceros add-repo <name> …/monoceros-e2e-fixture`** —
   die Workbench schreibt den Repo-Eintrag in die yml UND klont
   ihn sofort in den laufenden Container, ohne dass ein
   re-apply nötig ist.
4. **Filesystem-Probe**: `serve-ports.mjs` und `package.json`
   liegen unter `projects/monoceros-e2e-fixture/` im Container.
5. **Funktional-Probe**: `serve-ports.mjs` lässt sich starten und
   antwortet auf einem internen TCP-Port (`127.0.0.1:3000`) mit
   dem erwarteten JSON. Beweist: Repo-Inhalt ist nicht nur
   physisch da, sondern auch _funktional_.
6. **`monoceros remove`** räumt yml + Container + Bind-Mount
   `projects/` weg.

## Warum die Probe von innen kommt

`add-repo` testet absichtlich _nicht_ Traefik-Routing — das ist
`with-port`s Job. Wir wollen hier nur „Clone funktioniert, Inhalt
läuft" wissen. Der Probe per `curl` auf `127.0.0.1:3000` aus dem
Container heraus prüft genau das, ohne dass ein `add-port` oder
der Proxy ins Spiel kommt.

## Was es _nicht_ prüft

- Kein Traefik-Routing (siehe `with-port`).
- Kein init-time-Clone via `--with-repo` (siehe `with-services`).
- Keine HTTPS-Auth bei privaten Repos — die Fixture ist public.
- Kein `add-repo` _vor_ dem ersten Apply (sondern danach, dann
  on-the-fly).

## Voraussetzung

- `monoceros` auf PATH, Workbench 1.6.0+ (für die HTTPS-Repo-Auth-
  Mechanik).
- Docker-Daemon.
- Internet-Zugriff (HTTPS-Clone des Fixture-Repos).

## Laufzeit

~90 Sekunden auf einem warmen System.

## Asserts

| #   | Erwartung                                         |
| --- | ------------------------------------------------- |
| 1   | `serve-ports.mjs` und `package.json` im Container |
| 2   | `curl 127.0.0.1:3000` succeeds                    |
| 3   | response body enthält `"port":3000`               |

# Szenario `with-tunnel`

`monoceros tunnel <name> postgres` als Hintergrundprozess vom Host
aus starten und gegen die lokale Tunnel-Listen-Adresse TCP-proben.

## Was es prüft

1. **`monoceros init <name> --with-languages=node --with-services=postgres`** + **`apply`** —
   Compose-Mode-Container mit postgres läuft.
2. **Baseline-Probe**: `</dev/tcp/postgres/5432` aus dem Workspace,
   30s-Retry-Loop. Stellt sicher, dass postgres bereit ist, bevor
   wir den teureren Tunnel-Pfad antreten.
3. **`monoceros tunnel <name> postgres --local-port=15432`** als
   Background-Prozess vom Host — startet einen kurzlebigen
   `alpine/socat`-Sidecar (siehe ADR 0009), der
   `127.0.0.1:15432` → `postgres:5432` forwarded.
   - Wir nehmen Port `15432` statt des Default-`5432`, damit das
     Szenario auch dann durchgeht, wenn auf der Maschine schon ein
     lokaler postgres läuft.
4. **Host-side TCP-Probe**: `net.createConnection` aus Node gegen
   `127.0.0.1:15432`. Bis zu 15 Versuche × 500ms, weil socat-
   Startup beim ersten Aufruf das Image pullt.
5. **Teardown**: SIGINT an den Tunnel-Prozess — was der Builder mit
   Ctrl+C tut. socat hat `--rm`, der Container räumt sich selbst.

## Warum kein psql-Roundtrip?

Eine Postgres-`SELECT 1`-Probe vom Host würde einen psql-Client
voraussetzen — apt unter Linux, brew unter macOS, scoop/chocolatey
unter Windows. Das ist cross-OS-Reibung, die wir an dieser Stelle
vermeiden. Der CRUD-Beweis _vom Workspace aus_ ist schon in
`with-services` abgedeckt; hier geht's ausschließlich darum, dass
der host-seitige Tunnel-Endpunkt antwortet.

## Voraussetzung

- `monoceros` **1.10.0+** (der `tunnel`-Befehl wurde erst dort
  ausgeliefert).
- Docker-Daemon.
- Port 15432 frei auf dem Host.

## Laufzeit

~120 Sekunden auf einem warmen System. Erstaufruf zieht das
`alpine/socat:1.8.0.3`-Image (~5 MB) — einmalig.

## Asserts

| #   | Erwartung                                            |
| --- | ---------------------------------------------------- |
| 1   | `postgres:5432` reachable from workspace within 30s  |
| 2   | TCP connect to `127.0.0.1:15432` succeeds (von Host) |

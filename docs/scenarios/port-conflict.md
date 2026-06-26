# Szenario `port-conflict`

Beweist, dass die `apply`-Pre-Flight den Halter des Proxy-Host-Ports
**einordnet**, statt mit einer generischen „free the port"-Meldung
abzubrechen (Workbench `proxy/port-check.ts`).

## Was es prüft

1. **Setup**: `routing.hostPort` wird auf einen freien **hohen
   Testport** (`18099`) gelenkt, damit der Test nie mit dem echten
   `:80` kollidiert und keine Rechte braucht. `monoceros-proxy` wird
   entfernt - sonst überspringt die Pre-Flight die Prüfung („der Port
   gehört uns").
2. **Fall 1 - laufender Container**: ein
   `docker run -d -p 18099:80 …-hog traefik/whoami` belegt den Port.
   `monoceros apply` bricht ab (Exit ≠ 0), und die Meldung
   - sagt `published by a running container`, und
   - **nennt den Container** (`…-hog`) samt `docker stop`-Hinweis.
3. **Fall 2 - belegt, aber kein Container published ihn**: der Hog wird
   entfernt, stattdessen hält ein **Host-Listener** (Node `net`, hoher
   Port → kein root) `127.0.0.1:18099`. `monoceros apply` bricht ab und
   die Meldung
   - sagt `no running container publishes it`,
   - zeigt auf den verwaisten `docker-proxy` + `systemctl restart
docker`, und
   - bietet den `routing.hostPort`-Fallback an.

Beide Fälle scheitern in der Pre-Flight **vor** dem Container-Build,
daher schnell (kein `devcontainer up`).

## Warum kein echter verwaister docker-proxy?

Einen echten orphaned `docker-proxy` (der klassische
native-dockerd-in-WSL-Fall) kann man portabel nicht on-demand erzeugen.
Das bräuchte root bzw. einen Docker-Bug. Der Host-Listener triggert
exakt denselben Code-Pfad (`docker ps --filter publish=<port>` leer,
Port aber belegt) und damit dieselbe Meldung. Das Wording selbst ist
zusätzlich im Workbench-Unit-Test `proxy-port-check.test.ts`
festgenagelt.

## Voraussetzung

- `monoceros` **1.36.4+** (klassifizierende Pre-Flight).
- Docker-Daemon.
- Port `18099` frei auf dem Host.

## Laufzeit

~40 Sekunden. Erstaufruf zieht das kleine `traefik/whoami`-Image.

## Asserts

| #   | Erwartung                                                   |
| --- | ----------------------------------------------------------- |
| 1   | apply Exit ≠ 0, Meldung `published by a running container`  |
| 2   | Meldung nennt den belegenden Container (`…-hog`)            |
| 3   | apply Exit ≠ 0, Meldung `no running container publishes it` |
| 4   | Meldung nennt `docker-proxy` + `systemctl restart docker`   |
| 5   | Meldung bietet den `routing.hostPort`-Fallback an           |

# Szenario `alt-hostport`

Treibt einen **nicht-Default `routing.hostPort`** end-to-end durch und
prüft die drei Dinge, die sich ändern (und das eine, das sich **nicht**
ändern darf), wenn der Traefik-Proxy von `:80` wegzieht.

## Was es prüft

1. **Setup**: `routing.hostPort` wird auf einen freien hohen Port
   (`18080`) gelenkt; `monoceros-proxy` wird entfernt, damit
   `ensureProxy` einen frischen Proxy auf dem Alt-Port bindet (ein
   laufender Proxy wird sonst **per Name** wiederverwendet, der Port
   ignoriert). Restore in `finally`.
2. **Briefing**: nach `apply` tragen die `.localhost`-URLs in
   `AGENTS.md` den `:18080`-Suffix - Default-Route **und**
   Sekundär-Route. Ohne den Suffix bekäme ein Agent eine tote
   `:80`-URL. (Die „Suffix nur wenn ≠ 80"-Logik ist im Workbench-Unit-
   Test abgedeckt; hier wird bewiesen, dass `routing.hostPort` über ein
   echtes `apply` überhaupt im Briefing ankommt.)
3. **Routing**: `http://<name>.localhost:18080/` erreicht die App über
   den auf den Alt-Port gebundenen Proxy (JSON-`port`-Probe vom Host).
4. **Share ist unabhängig vom Proxy-Port**: `monoceros share <name>
monoceros-e2e-fixture` forwardet die **eigenen App-Ports** der App
   über einen socat-Sidecar, nie über Traefik. Eine TCP-Probe auf
   `127.0.0.1:5173` (nicht über `:18080`) beweist, dass Share mit
   geändertem `hostPort` unverändert funktioniert.

## Warum gerade Share?

Share/Tunnel umgehen den Traefik-Proxy komplett (socat auf dem rohen
App-Port, kein `routing.hostPort`-Bezug). Der `hostPort`-Wechsel ist
also genau die Änderung, bei der man sich fragt „bricht das Share?" -
dieses Szenario zeigt schwarz auf weiß, dass es das nicht tut.

## Voraussetzung

- `monoceros` **1.36.4+** (`hostPort` fließt ins Briefing).
- Docker-Daemon, Netzzugang (klont das Fixture-Repo).
- Ports `18080` und `5173` frei auf dem Host.

## Laufzeit

~180 Sekunden (voller Container-Build + Fixture-Clone). Erstaufruf
zieht das `alpine/socat`-Image für Share.

## Asserts

| #   | Erwartung                                                    |
| --- | ------------------------------------------------------------ |
| 1   | AGENTS.md Default-Route zeigt `…localhost:18080`             |
| 2   | AGENTS.md Sekundär-Route zeigt `…-3001.localhost:18080`      |
| 3   | keine suffixfreie `<name>.localhost`-URL im Briefing         |
| 4   | `http://<name>.localhost:18080/` liefert `port = 5173`       |
| 5   | Host-TCP-Connect auf `127.0.0.1:5173` (Share-Forward) klappt |

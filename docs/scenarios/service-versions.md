# Szenario `service-versions`

Ein eigener Service in zwei Versionen. Prüft mit installierter CLI und
echten Containern, dass eine Workbench die Version ihres Services kennt,
dass `upgrade` eine neue Version hineinbringt und dass eine fehlende
Datei `apply` nicht aufhält
([workbench#139](https://github.com/getmonoceros/workbench/issues/139),
ADR 0066 im Workbench).

## Worum es geht

`add-service` und `init` schreiben den Block eines Services in die yml
und darunter `ref: <id>@<version>`. `apply` liest Briefing und die
anderen Descriptor-Daten genau aus dieser Version. Eine neuere Version
kommt nur über `upgrade` in eine bestehende Workbench.

## Was es prüft

1. Schreibt `e2e-cache` (Redis) als eigenen Service in Version 1 nach
   `$MONOCEROS_HOME/templates/services/e2e-cache.yml`.
2. **`init --with-services=e2e-cache`**: die yml trägt
   `ref: e2e-cache@1`.
3. **`apply`**: `AGENTS.md` enthält das Briefing von Version 1.
4. Legt Version 2 daneben (alte Datei als `e2e-cache@1.yml`, neues
   Healthcheck-Intervall, neues Briefing).
5. **`upgrade <name> <runtime>`** mit der Runtime, die schon in der yml
   steht: meldet `e2e-cache 1 → 2`, die yml trägt `ref: e2e-cache@2` und
   das neue Intervall, `AGENTS.md` das Briefing von Version 2.
6. Entfernt beide Descriptor-Dateien.
7. **`apply`**: endet mit 0, nennt die fehlende `e2e-cache.yml`, und in
   `AGENTS.md` steht kein Briefing mehr dafür.

Die beiden Descriptor-Dateien werden am Ende in jedem Fall wieder
entfernt.

## Was es _nicht_ prüft

- Den Dreiwegevergleich im Einzelnen (eigene Änderungen, Konflikte,
  `--replace`): das decken die Unit-Tests im Workbench ab.
- Mitgelieferte Services in einer zweiten Version: es gibt noch keine.

## Voraussetzung

- `monoceros` auf PATH, mit versionierten Services (ADR 0066).
- Docker-Daemon läuft.

## Laufzeit

~20 Sekunden auf einem warmen System. Erstaufruf länger, weil das
Runtime-Image und `redis:8` gezogen werden.

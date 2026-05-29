# Szenario `with-port`

Zwei parallel laufende Container hinter dem Traefik-Singleton, mit
`add-port` mid-flight und Persistenz nach einem zweiten `apply`.

## Was es prüft

In dieser Reihenfolge:

1. **Init + apply** für zwei Container mit identischer Konfig
   (`--with=node --with-ports=3000`) und dem gleichen Fixture-Repo.
2. **`serve-ports.mjs`** läuft in beiden mit den Ports 3000 _und_
   5173 — 5173 ist noch nicht geroutet, aber der Prozess hört schon
   mit. Damit kann der spätere `add-port` ohne Service-Neustart die
   Route freischalten.
3. **Phase 1 — Hostname-Routing**: HTTP-Probe gegen
   `http://<a>.localhost/` und `http://<b>.localhost/`. Beide
   antworten mit JSON, in dem `port: 3000` steht. Beweist:
   Traefik routet zwei Container auf dem gleichen internen Port
   sauber über ihre jeweiligen Hostnames.
4. **Mid-flight `monoceros add-port <a> -- 5173`**. Kein Container-
   Rebuild, kein Apply — nur yml-Update + Traefik-Hot-Reload via
   File-Provider.
5. **Hot-Reload-Wirkung**: HTTP-Probe gegen `http://<a>-5173.localhost/`.
   Antwort-JSON enthält `port: 5173`. Beweist: Traefik hat die
   neue Route innerhalb von Sekunden übernommen.
6. **Isolation**: `http://<b>.localhost/` antwortet weiter mit
   `port: 3000`. Beweist: `add-port` auf `<a>` betrifft `<b>` nicht.
7. **Re-apply `<a>`**: `monoceros apply <a>` force-removed den
   Container und baut ihn neu. Die yml ist die Quelle — Port 5173
   ist darin persistiert.
8. **`serve-ports.mjs` in `<a>` neu starten** (der Prozess starb
   beim Recreate).
9. **Persistenz-Probe**: HTTP-Probe gegen `http://<a>-5173.localhost/`
   muss weiter `port: 5173` liefern. Beweist: der Port-Eintrag hat
   den Apply überlebt, Apply re-publiziert die Route automatisch.
10. **Teardown**: Sibling explizit weg, Primary über das Framework.

## URL-Konvention

Per ADR 0007 + `docs/commands/port.md` der Workbench:

- `http://<name>.localhost/` — erster Port in `routing.ports`
  (Default-Route).
- `http://<name>-<port>.localhost/` — jeder explizit hinzugefügte
  Port.

Bei nicht-Default `routing.hostPort` (z. B. 8080) hängt der
host-port suffixartig dahinter:
`http://<name>-5173.localhost:8080/`. Das Szenario setzt
Default-Config (hostPort=80) voraus.

## Voraussetzung

- `monoceros` auf PATH, Workbench 1.7.0+ (für `add-port` /
  `--with-ports`).
- Docker-Daemon mit Compose v2.
- Internet-Zugriff (HTTPS-Clone des Fixture-Repos).
- Port 80 frei auf dem Host (Traefik-Singleton braucht das).

## Laufzeit

~180 Sekunden auf einem warmen System. Vier `monoceros apply`-Aufrufe
(zwei initial, einer als Re-apply, plus die Force-Recreates)
dominieren die Zeit.

## Asserts

| #   | Erwartung                                                              |
| --- | ---------------------------------------------------------------------- |
| 1   | `http://<a>.localhost/` returns `port: 3000`                           |
| 2   | `http://<b>.localhost/` returns `port: 3000`                           |
| 3   | `http://<a>-5173.localhost/` returns `port: 5173` after `add-port`     |
| 4   | `http://<b>.localhost/` still returns `port: 3000` (isolation)         |
| 5   | `http://<a>-5173.localhost/` still returns `port: 5173` after re-apply |

## Zwei-Container-Setup

Im Unterschied zu den anderen Szenarien legt dieses zwei Container
an. Der primary nutzt `ctx.name`, den das Framework am Ende sauber
abräumt (oder per `--keep` stehen lässt). Der sibling heißt
`${ctx.name}-2` und wird vom Szenario am Ende explizit per
`monoceros remove` entfernt.

Auf einem Fail bleiben beide Container stehen — der Pre-Flight-
Cleanup beim nächsten Lauf greift sie ab (matcht den Präfix `e2e-`).

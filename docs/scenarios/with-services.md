# Szenario `with-services`

Compose-Mode mit einem Postgres-Service-Container — TCP-Probe als
Baseline, Postgres-Wire-Protokoll-Roundtrip via `pg` als
substantieller Beweis.

## Was es prüft

In dieser Reihenfolge:

1. **`monoceros init <name> --with-languages=node --with-services=postgres
--with-repos=…/monoceros-e2e-fixture`** schreibt eine yml mit
   Compose-Services und einer Repo-Referenz. Beweist init + Schema.
2. **`monoceros apply <name>`** fährt workspace + postgres hoch und
   klont den Fixture-Repo nach `projects/monoceros-e2e-fixture/`.
3. **TCP-Probe** auf `postgres:5432` aus dem Workspace. Bash-builtin
   `</dev/tcp/postgres/5432` mit 30s-Retry-Loop. Fail-fast: wenn der
   Port nicht aufgeht, brechen wir ab, bevor wir die teurere Strecke
   überhaupt antreten. Beweist Compose-Default-Netzwerk + DNS.
4. **`npm ci` in der Fixture** zieht `pg` rein. Beweist nebenbei,
   dass post-create-Auth + Internet-Zugriff im Container
   funktionieren.
5. **`node db-client.mjs`** — siehe
   [monoceros-e2e-fixture/db-client.mjs](https://github.com/getmonoceros/monoceros-e2e-fixture/blob/main/db-client.mjs).
   Verbindet sich per `pg`-Treiber, legt eine TEMP-Tabelle an,
   schreibt zwei Zeilen, liest sie zurück und verifiziert die
   Inhalte, löscht eine, prüft die verbleibende Anzahl. Letzte
   stdout-Zeile muss `ok` sein. Beweist Postgres-Wire-Protokoll +
   Service-Credentials aus dem Service-Catalog.
6. **`monoceros remove <name>`** räumt Compose-Stack, das
   `data/postgres/`-Bind-Mount, den geclonten Fixture-Pfad und yml ab.

## Was es _nicht_ prüft

- Keine Persistenz über Container-Restarts (separate Sache).
- Keine echten Migrationen / Schema-Versionierung — der db-client
  benutzt eine TEMP-Tabelle, die mit dem Verbindungs-Ende verschwindet.

## Voraussetzung

- `monoceros` auf PATH, Workbench 1.6.0+ (für `--with-repos`).
- Docker-Daemon mit Compose v2.
- Internet-Zugriff (HTTPS-Clone des Fixture-Repos, `npm install`).

## Laufzeit

~150 Sekunden auf einem warmen System. Erstaufruf zieht das postgres-
Image (~150 MB) und die `pg`-npm-Deps; kann 2-3 Minuten dauern.

## Asserts

| #   | Erwartung                                       | Quelle                |
| --- | ----------------------------------------------- | --------------------- |
| 1   | `postgres:5432` reachable from workspace in 30s | TCP-Probe (Bash)      |
| 2   | `npm ci` exits 0                                | Fixture-Install       |
| 3   | `db-client.mjs` exits 0                         | CRUD-Probe (Node, pg) |
| 4   | letzte stdout-Zeile ist `ok`                    | CRUD-Probe-Output     |

## Warum zwei Probe-Ebenen

Der TCP-Probe ist schnell und sagt: „etwas hört auf 5432" — er
übersieht aber Credential-Probleme, falsche Datenbank-Initialisierung
oder ein blockiertes Postgres-Statup. Der db-client-Roundtrip
inszeniert eine echte Anwendungs-Konversation und beweist, dass der
Service tatsächlich brauchbar ist.

Beide bleiben drin: TCP zuerst (kostet nichts, bricht früh ab), dann
der teurere CRUD-Test.

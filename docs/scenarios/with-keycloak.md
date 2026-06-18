# Szenario `with-keycloak`

Compose-Mode mit dem Keycloak-Service — der End-to-End-Beweis für
**deferred service start** (ADR 0025). Keycloak braucht seine
`realm.json` zum Boot, aber das Realm ist ein Projektartefakt, das erst
mit dem In-Container-Klon (post-create) ankommt — also _nachdem_ die
Services normalerweise starten. Der kuratierte keycloak-Service ist
`deferStart`, kommt also in einer host-seitigen zweiten Welle hoch,
sobald der Klon durch ist. Ein echter OIDC-Token-Roundtrip gegen das
importierte Realm ist der substantielle Beweis.

## Was es prüft

In dieser Reihenfolge:

1. **`monoceros init <name> --with-languages=node --with-services=keycloak
--with-repos=…/monoceros-e2e-fixture`** schreibt eine Compose-yml mit
   keycloak + Fixture-Repo. Der keycloak-Eintrag bringt `command:
start-dev --import-realm` und einen kommentierten `volumes:`-Scaffold
   mit.
2. **Realm mounten** — das Szenario füllt den `volumes:`-Scaffold (was
   ein Builder von Hand tut; es gibt kein add-volume-CLI) und zeigt ihn
   auf `projects/monoceros-e2e-fixture/keycloak/e2e-realm.json`.
3. **`monoceros apply <name>`** fährt den Workspace hoch, klont die
   Fixture, und startet keycloak in der **zweiten Welle** danach — zu
   diesem Zeitpunkt liegt die `realm.json` auf der Platte und wird
   importiert.
4. **`node keycloak-client.mjs`** — siehe
   [monoceros-e2e-fixture/keycloak-client.mjs](https://github.com/getmonoceros/monoceros-e2e-fixture/blob/main/keycloak-client.mjs).
   Asserted `KEYCLOAK_URL` (ADR 0021), wartet auf Keycloaks Hochlauf und
   macht einen client-credentials-Token-Request gegen das importierte
   Realm `monoceros-e2e` (Client `e2e-probe`). Ein Token zurück beweist:
   Realm gemountet, importiert, und Auth funktioniert. Letzte
   stdout-Zeile muss `ok` sein. Nutzt nur das eingebaute `fetch` — kein
   `npm ci` nötig.
5. **`monoceros remove <name>`** räumt Compose-Stack, geclonten
   Fixture-Pfad und yml ab.

## Was es _nicht_ prüft

- Keine UI-/Theme-Strecke (Theme-Mount ist dokumentiert, aber hier nicht
  getestet).
- Keine Persistenz: die H2-DB ist bewusst flüchtig und re-seedet bei
  jedem apply aus der `realm.json`.

## Voraussetzung

- `monoceros` auf PATH, Workbench mit dem keycloak-Service + `deferStart`
  (ADR 0025).
- Docker-Daemon mit Compose v2.
- Internet-Zugriff (HTTPS-Clone des Fixture-Repos, Keycloak-Image-Pull).

## Laufzeit

~240 Sekunden auf einem warmen System. Erstaufruf zieht das
Keycloak-Image und braucht für den Cold-Boot + Realm-Import spürbar
Zeit; die Probe retryt großzügig (bis 150s).

## Asserts

| #   | Erwartung                     | Quelle                     |
| --- | ----------------------------- | -------------------------- |
| 1   | `keycloak-client.mjs` exits 0 | OIDC-Probe (Node, `fetch`) |
| 2   | letzte stdout-Zeile ist `ok`  | OIDC-Probe-Output          |

## Warum ein Auth-Roundtrip statt nur TCP

Ein TCP-Probe auf `keycloak:8080` würde nur sagen „etwas hört auf dem
Port" — er übersähe, ob das Realm überhaupt importiert wurde. Genau das
ist hier der Kern: der client-credentials-Grant trifft das Realm-eigene
Token-Endpoint (`/realms/monoceros-e2e/...`), das es nur gibt, wenn die
gemountete `realm.json` zum (verzögerten) Boot da war und importiert
wurde. Eine Regression der zweiten Welle ergäbe ein leeres Keycloak und
einen 404 — der Roundtrip schlüge fehl.

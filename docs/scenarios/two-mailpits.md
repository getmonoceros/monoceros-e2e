# Szenario `two-mailpits`

Zwei Workbenches auf derselben Maschine, beide mit Mailpit. Prüft, dass
jede Workbench ihre eigene Instanz erreicht: von innen, über die
Proxy-Route und über `share`
([workbench#124](https://github.com/getmonoceros/workbench/issues/124)).

## Worum es geht

Ein Service mit `httpPort` hängt im maschinenweiten Netz
`monoceros-proxy`, damit Traefik `<workbench>-<service>.localhost`
routen kann. Solange Compose ihn dort eingehängt hat, bekam er dort
auch seinen Service-Namen. Zwei Workbenches mit Keycloak antworteten
dann beide auf `keycloak`, und eine App landete bei jedem zweiten
Request in der fremden Instanz. Jeder Workspace mit Ports antwortete
dort genauso auf `workspace`.

Mailpit steht für Keycloak: derselbe `httpPort`-Weg, startet in
Sekunden, und über seine API hinterlässt jede Workbench eine
Marker-Mail, an der man sieht, welche Instanz geantwortet hat.

## Was es prüft

1. **`init`** + **`apply`** für zwei Workbenches, jeweils
   `--with-services=mailpit --with-ports=3000`.
2. Jede Workbench schickt aus ihrem Workspace eine Marker-Mail an
   `mailpit:8025`.
3. **Proxy-Netz**: Workspace und Mailpit beider Workbenches hängen in
   `monoceros-proxy`, aber nur unter `<name>` bzw. `<name>-mailpit`,
   nie unter `workspace` oder `mailpit`. Aus einem Wegwerf-Container
   im Netz lösen die nackten Namen auf keinen der Container des Laufs
   auf, jeder Präfix-Alias auf genau einen.
4. **Innen**: `mailpit` löst im Workspace nur auf die eigene Instanz
   auf, und zehn Lesezugriffe liefern alle die eigene Marker-Mail.
5. **Routen**: `<name>-mailpit.localhost` liefert für beide
   Workbenches die eigene Marker-Mail.
6. **Share**: `monoceros share <a> none` läuft im Hintergrund,
   `https://127.0.0.1:8025` liefert die Marker-Mail von `<a>`.
7. **Lebenszyklus**: Nach `docker restart` des Mailpit-Containers
   antwortet die Route weiter. Nach `stop --down` + `start` (frische
   Container) stimmen Namen und Route wieder.

Die Prüfung der nackten Namen ist auf die Container dieses Laufs
beschränkt. Workbenches, die eine ältere CLI angelegt hat, tragen die
nackten Aliase noch bis zum nächsten `apply`, und die sind nicht
Gegenstand des Tests.

## Voraussetzung

- Docker-Daemon, Port 80 (Proxy) und 8025 (Share) frei.
- Das Image `alpine:3.21` für die Namensauflösung im Proxy-Netz
  (wird beim ersten Lauf gezogen).

## Laufzeit

~40 Sekunden auf einem warmen System, im CI mit kaltem Image-Cache länger.

# Keycloak-Anbindung in Seschat

> Lokale Lesedatei. Nicht committen, nicht pushen. Sie ist über `.git/info/exclude` lokal ausgeblendet.
>
> Stand: Seschat-Client `0.0.172`, `@11880/common-components` `0.44.4`, `keycloak-js` `24.0.2`.

---

## Inhalt

1. [Teil 1 – Die Anleitung: was passiert, wenn jemand die App aufruft](#teil-1--die-anleitung)

---

# Teil 1 – Die Anleitung

Kurz gefasst: Seschat ist ein **Public OIDC Client** im Authorization-Code-Flow **mit PKCE**. Das Frontend hält niemals ein Passwort und niemals ein Client-Secret. Es bekommt vom Keycloak ein Access-Token und schickt das als `Authorization: Bearer …` an zwei verschiedene Server: an das **eigene WAR-Backend** (`/Seschat/api/*`, liefert Server-Properties und nimmt Logs an) und an das **Fachbackend Seschat_Api** (liefert Rückstellungen, Buchungen, Stammdaten, Berechtigungen).

Die Berechtigung wird **mehrfach** geprüft, an vier unabhängigen Stellen:

| Stufe | Wo | Was geprüft wird | Ergebnis bei Fehlschlag |
|---|---|---|---|
| A | Keycloak selbst | Wer bist du? (Login, ggf. SSO-Sitzung) | Kein Token, kein Rücksprung |
| B | Browser, `KeycloakAuth` der Library | `reactAuth.status` im Token = „darf diese Anwendung überhaupt benutzt werden“ | Sperrseite statt App |
| C | Browser, `ProtectedPage` in `App.tsx` | Fachrollen aus `GET /user/berechtigung` = „welche Bereiche darf dieser Nutzer sehen“ | Umleitung oder Sperrpanel |
| D | Server, `Authenticator` + Seschat_Api | Signatur, Issuer, `azp`, `reactAuth.status` — bei jeder einzelnen Anfrage | HTTP 401 |

**Wichtig für das Verständnis:** Stufe B und C sind *Anzeigelogik*. Sie machen die App bedienbar und verhindern, dass jemand in einem Bereich landet, in dem es für ihn nichts zu holen gibt. Die eigentliche Absicherung ist Stufe D — die läuft auf dem Server und lässt sich vom Browser aus nicht umgehen. Wer im Frontend den React-State manipuliert, sieht höchstens eine leere Tabelle plus 401/403.

## Der Ablauf Schritt für Schritt

### 1. Seite wird geladen

Der Browser holt `https://<server>/Seschat/` — eine statische, von Parcel gebaute `index.html` plus Bundle. Bis hierhin ist nichts geschützt; das ist bei einer SPA auch nicht nötig, weil im Bundle keine Daten stecken.

### 2. Keycloak-Konfiguration nachladen

`index.tsx` rendert zuerst nur die Komponente `Index`. Die ruft `useKeycloakConfig()` auf, und die macht einen `GET /Seschat/api/kc-config`. Antwort:

```json
{ "url": "https://keycloak…/", "realm": "11880.com", "clientId": "Seschat" }
```

Solange das läuft, sieht der Nutzer nur den Spinner „Seschat wird geladen …“. Schlägt es fehl, kommt die Startmeldung „Keycloak-Konfiguration konnte nicht geladen werden.“ und **nichts weiter** — ohne Konfiguration gibt es keinen Login.

Der Grund für diesen Umweg: URL, Realm und Client-ID stehen nicht im Bundle, sondern als System-Properties auf dem WildFly. Test- und Produktivserver liefern damit dieselbe WAR mit unterschiedlicher Keycloak-Anbindung aus.

### 3. `KeycloakAuth` startet den Login

Erst wenn die Konfiguration da ist, wird `<KeycloakAuth config={config}>` gerendert. Deren Effekt legt eine `keycloak-js`-Instanz an und ruft `init({ onLoad: 'login-required', checkLoginIframe: false })`.

`login-required` heißt: kein stilles Nachschauen, keine Iframe-Prüfung — wenn keine gültige Sitzung vorliegt, wird **sofort** auf die Keycloak-Anmeldeseite umgeleitet. Vorher erzeugt `keycloak-js` noch:

* `state` (UUID) — gegen CSRF beim Rücksprung,
* `nonce` (UUID) — gegen Token-Replay im ID-Token,
* `code_verifier` (96 Zeichen Zufall) und daraus den `code_challenge` (SHA-256, base64url) — **PKCE**.

`state`, `nonce`, `redirectUri` und `code_verifier` werden unter dem Schlüssel `kc-callback-<state>` im **localStorage** abgelegt (Ablauf: 1 Stunde). Fällt localStorage aus, weicht die Library auf ein Cookie aus.

Die Adresse, auf die umgeleitet wird, sieht so aus:

```
https://keycloak…/realms/11880.com/protocol/openid-connect/auth
  ?client_id=Seschat
  &redirect_uri=<aktuelle Seite, inkl. Pfad>
  &state=<uuid>
  &response_mode=fragment
  &response_type=code
  &scope=openid
  &nonce=<uuid>
  &code_challenge=<sha256(verifier), base64url>
  &code_challenge_method=S256
```

`redirect_uri` ist die **aktuell aufgerufene Seite**, nicht ein fester Startpfad. Deshalb landet man nach dem Login wieder auf `/Seschat/buchhaltung`, wenn man das aufgerufen hatte. Diese URL muss im Keycloak-Client als Redirect-URI freigegeben sein, sonst lehnt Keycloak ab — das ist die erste Bremse gegen Umleitung auf fremde Ziele.

### 4. Keycloak authentifiziert und springt zurück

Der Nutzer meldet sich an (oder hat eine laufende SSO-Sitzung im Realm und merkt von diesem Schritt nichts). Keycloak leitet zurück auf:

```
https://<server>/Seschat/…#code=<einmal-code>&state=<uuid>&session_state=…&iss=…
```

Der Code steht im **Fragment** (`#`), nicht im Query-String — Fragmente werden vom Browser nicht an den Server geschickt und tauchen daher in keinem Zugriffslog auf.

### 5. Der Rücksprung wird eingelöst

Die Seite lädt komplett neu, Schritt 1–3 laufen erneut — aber diesmal findet `keycloak-js` in der URL einen Callback. `processInit()` tut dann drei Dinge:

1. **URL putzen**: `history.replaceState` entfernt `code`, `state` und Konsorten aus der Adresszeile, bevor irgendetwas anderes passiert. Der Code steht danach nirgends mehr.
2. **`state` prüfen**: Der zurückgegebene `state` wird im localStorage gesucht. Fehlt der Eintrag, ist `callback.valid` falsch und der Rücksprung wird als ungültig behandelt. Das ist der CSRF-Schutz: Ein fremd untergeschobener `code` hat keinen passenden gespeicherten `state`.
3. **Code gegen Token tauschen**: `POST /realms/…/protocol/openid-connect/token` mit `grant_type=authorization_code`, dem `code`, der `redirect_uri` und dem gespeicherten `code_verifier`. Keycloak rechnet den Verifier gegen den beim Login geschickten Challenge — nur wer den Login selbst angestoßen hat, kann den Code einlösen (PKCE).

Zurück kommen `access_token`, `refresh_token` und `id_token`. Danach prüft die Library noch die `nonce` im ID-Token gegen die gespeicherte; passt sie nicht, wird das Token sofort verworfen.

**Alle Tokens liegen ausschließlich im Speicher der Keycloak-Instanz.** Kein localStorage, kein Cookie, kein Redux. Ein Reload bedeutet einen neuen Durchlauf (dann still, weil die Keycloak-Sitzung steht).

### 6. Erste Berechtigungsprüfung: `reactAuth.status`

Jetzt kommt der Teil, der für die Frage nach „unberechtigte Leute kommen nicht durch“ zentral ist.

Das Access-Token von 11880 trägt einen **eigenen Claim `reactAuth`**, den Keycloak beim Ausstellen befüllt. Er sieht so aus:

```json
"reactAuth": {
  "status": 0,
  "uidspx": "<SPX-Kennung>",
  "berechtigungsobjekt": { "usergruppenobjekt": { } }
}
```

`status` bedeutet:

| Wert | Bedeutung | Was die App zeigt |
|---|---|---|
| `0` | zugelassen | die App |
| `1` | nicht für **diese** Anwendung zugelassen | Sperrseite „User nicht zugelassen“ mit Logout-Link |
| `2` | gar nicht für interne Anwendungen zugelassen | Sperrseite mit 10-Sekunden-Countdown und Zwangslogout |
| `-1` | Claim fehlt ganz (Fallback) | „Ein unbekannter Fehler ist aufgetreten“ |

`KeycloakAuth` rendert `props.children` **nur** bei `status === 0`. Bei allem anderen kommt die Sperrseite und die App wird gar nicht erst gemountet. Zusätzlich wirft `useKeycloak()` selbst einen Fehler, wenn der Status nicht 0 ist — das ist die Rückfallebene, falls jemand den Context an der Sperrseite vorbei benutzt.

Das ist die **Anwendungszulassung**: „Darf dieser Mitarbeiter Seschat überhaupt öffnen?“ Sie wird zentral in Keycloak gepflegt, nicht in Seschat.

### 7. Zweite Berechtigungsprüfung: Fachrollen aus dem Backend

Der `reactAuth`-Status sagt nur ja/nein zur Anwendung. **Welche Bereiche** jemand in Seschat sehen darf, steht nicht im Token, sondern kommt aus dem Fachbackend:

```
GET <seschat.backend.root>/user/berechtigung
Authorization: Bearer <access_token>
```

Antwort (vereinfacht):

```json
{
  "errorcode_http": "200",
  "errorcode_intern": "OK",
  "data": {
    "rollen": ["BUCHHALTUNG"],
    "user_uuid": "…",
    "firmierung": [ { "uuid": "…", "name": "…", "fachbereich": [] } ]
  }
}
```

Die drei bekannten Rollen sind `ADMIN`, `BUCHHALTUNG`, `ANWENDER`, und sie bilden 1:1 auf die drei geschützten Bereiche ab. Dieser Aufruf läuft als React-Query `['current-user-permissions']` im `ApiProvider` und steht danach der ganzen App zur Verfügung.

Die Antwort wird **streng** validiert (`validateCurrentUserAuthorization` in `modules/rbac.ts`): unbekannte Rolle → Fehler, leere Rollenliste → Fehler, verbotene Kombination (`BUCHHALTUNG`+`ANWENDER`, `ADMIN`+`ANWENDER`) → Fehler, kaputte Hülle → Fehler. Es gibt **keinen** „dann halt ohne Rolle weiter“-Pfad.

### 8. Routing: nur erlaubte Bereiche

Jede geschützte Route in `App.tsx` steckt in einer `ProtectedPage`, die drei Fälle in dieser Reihenfolge abarbeitet:

1. **lädt noch** → Spinner. Wichtig: in diesem Zustand wird **nichts** gerendert, was Daten zeigt.
2. **Fehler oder gar keine Berechtigung geladen** → Panel „Keine gültige Berechtigung geladen“ mit „Erneut laden“. Der Bereich bleibt zu. Das ist der entscheidende Punkt: Ein fehlgeschlagener Berechtigungsabruf öffnet die App nicht, er sperrt sie.
3. **Berechtigung da, aber Rolle passt nicht zum Bereich** → `<Navigate>` auf den ersten erlaubten Pfad, mit `state.accessDenied`. Oben erscheint dann für 20 Sekunden der gelbe Hinweis „Für den direkt aufgerufenen Bereich liegt keine passende Rolle vor.“

Das Menü selbst entsteht aus denselben Daten (`buildRbacMenu`), es enthält also gar keine Einträge für gesperrte Bereiche. Das Tippen von `/Seschat/admin` in die Adresszeile führt trotzdem durch `ProtectedPage` — deshalb bringt es nichts.

### 9. Jeder Datenabruf holt sich ein frisches Token

Alle Fetch-Helfer rufen vorher `await getAuthorization()`. Das ist keine Variable, sondern eine Funktion, die `keycloak.updateToken(5)` macht: Läuft das Token in weniger als 5 Sekunden ab, wird es per `refresh_token` erneuert; sonst wird das vorhandene zurückgegeben. Erst danach entsteht der Header `Authorization: Bearer …`.

Klappt der Refresh nicht (Sitzung in Keycloak beendet, Refresh-Token abgelaufen), ruft `getAuthorization` `instance.login()` — voller Redirect zurück zum Keycloak. Für den Nutzer sieht das aus wie ein automatisches Neuanmelden.

### 10. Der Server prüft noch einmal — bei jedem Request

Beides, das WAR-Backend und Seschat_Api, glaubt dem Browser kein Wort. Beim WAR-Backend macht das der `Authenticator` (JAX-RS-`ContainerRequestFilter`, an `@Secured` gebunden). Er prüft pro Anfrage:

* Ist ein `Authorization: Bearer <jwt>` da und wohlgeformt?
* Ist die **RSA-Signatur** gültig? Der öffentliche Schlüssel kommt über JWKS von `<realm>/protocol/openid-connect/certs`, ausgewählt über die `kid` im Token-Header.
* Ist der **Issuer** genau die konfigurierte Realm-URL?
* Ist `azp` (die ausstellende Client-ID) in der Liste `seschat.authorized_clients`?
* Ist `reactAuth.status == 0`?
* Ist das Token nicht abgelaufen (5 Sekunden Toleranz)?

Fällt eines davon durch: `401` mit „Die Anfrage konnte nicht autorisiert werden.“ Und zwar bevor irgendein Resource-Code läuft.

### 11. Abmelden

Der Logout im Nutzermenü ruft `instance.logout()` — Redirect auf den Keycloak-Logout-Endpunkt, der die SSO-Sitzung im Realm beendet. Damit ist man auch aus den anderen 11880-Anwendungen draußen.

---


**Der Startfehler-Blindfleck.** Kommt die App nicht bis `startConsoleLogForwarding`, bleiben die gesammelten Konsolenzeilen im Puffer liegen und erreichen den Server nie. Das betrifft genau die Fälle „Keycloak-Config schlägt fehl“ und „Provider stürzt ab“. Das ist unvermeidlich: Ohne Token nimmt der Log-Endpunkt nichts an. Der Frühpuffer hilft für alles, was **nach** einem erfolgreichen Start schiefgeht.

**`checkLoginIframe: false`** heißt: kein Dauer-Polling gegen Keycloak, aber auch keine sofortige Reaktion auf ein Single-Logout in einer anderen Anwendung. Das fällt erst beim nächsten Refresh auf. Bewusster Tausch — moderne Browser blockieren Third-Party-Cookies, das Iframe wäre ohnehin unzuverlässig.

**Die `busy`-Ref in `KeycloakAuth`** ist kein Schönheitsfehler, sondern verhindert unter `StrictMode` einen zweiten `init()` auf demselben, bereits verbrauchten Callback.

**Zwei `kc-config`-Aufrufe lokal** kommen ebenfalls von `StrictMode`. Der GET ist idempotent, das wurde bewusst in Kauf genommen, um die `ErrorBoundary` über `Index` setzen zu können.

**Der Query-Parameter-Fallback für `Authorization`** (`readAuthorizationHeader`) ist eine Altlast für Fälle ohne Header-Kontrolle. Query-Strings landen in Zugriffslogs — für neue Endpunkte nicht verwenden. Die Frontend-Regel „niemals Query-Strings loggen“ (`pathOnly` kappt am `?`) hängt damit zusammen.

**`JWTHelper.decodeRequestAuth` prüft nicht.** Es dekodiert nur. Nur hinter dem `Authenticator` benutzen. Der Javadoc sagt es, die Methodensignatur nicht — das ist die gefährlichere Stelle im Backend, wenn jemand sie an einem ungeschützten Endpunkt verwendet.

**Der JWKS-Provider ist statisch pro Issuer.** Ihn wieder pro Request zu bauen, würde Cache, Rate-Limit und Timeout verlieren — die Bemerkung im Code beschreibt genau diesen bereits behobenen Fehler.

**Die Reihenfolge der `catch`-Blöcke in `verifyJWT`** ist funktional: `TokenExpiredException` und `SignatureVerificationException` erben von `JWTVerificationException` und müssen davor stehen.

**Defaults zeigen überall auf „gesperrt“.** `reactAuth ?? { status: -1 }`, `getOrDefault("status", -1)`, `getAllowedAreas(undefined) === []`, `timeSkew == null → isTokenExpired() === true`. Das ist der durchgehende Zug dieser Anbindung, und wer hier etwas ändert, sollte ihn beibehalten.

**Unbekannte Rolle ist ein Fehler, kein Ignorieren.** `normalizeRole` wirft. Wird im Backend eine vierte Rolle eingeführt, ohne `KNOWN_ROLES` in `rbac.ts` zu erweitern, sperrt sich die App für die betroffenen Nutzer komplett aus. Das ist Absicht — die Alternative wäre, jemanden mit einer Rolle zu bedienen, die das Frontend nicht versteht.

**Der Token-Speicher ist ausschließlich der Arbeitsspeicher.** Kein `localStorage`, kein Cookie. Im localStorage steht nur der kurzlebige `kc-callback-<state>`-Eintrag mit `state`, `nonce`, `redirectUri` und `code_verifier`, und der wird beim Lesen gelöscht.

**Frontend-Prüfungen sind Bequemlichkeit, keine Absicherung.** Die Sicherheit steckt in der Signaturprüfung, in `azp`, in `reactAuth.status` auf dem Server und in den Rollenprüfungen des Fachbackends. Wer am Frontend arbeitet, darf sich darauf verlassen, dass ein Fehler dort keine Daten freigibt — aber er darf nie eine Prüfung *aus* dem Backend *ins* Frontend verschieben.

---

## Kurzreferenz: welche Datei macht was

| Datei | Rolle |
|---|---|
| `src/web/index.tsx` | Startreihenfolge: Config → `KeycloakAuth` → `ApiProvider` → `App` |
| `src/web/modules/api.ts` | `appRoot`, `contextRoot`, `useKeycloakConfig` |
| `node_modules/@11880/common-components/…/KeycloakAuth.js` | Keycloak-Start, `getAuthorization`, `reactAuth`-Torwächter |
| `node_modules/@11880/common-components/…/app.d.ts` | Typvertrag von Token und Context |
| `node_modules/keycloak-js/dist/keycloak.mjs` | OIDC-Flow, PKCE, Callback-Prüfung, Token-Refresh |
| `src/web/hooks/useCurrentUserPermissions.ts` | `GET /user/berechtigung` + Antwortvalidierung |
| `src/web/modules/rbac.ts` | Rollen → Bereiche, Menü, Validierung (reine Funktionen) |
| `src/web/providers/ApiProvider.tsx` | Berechtigung in den Context, Property-Preload, Logging |
| `src/web/components/App.tsx` | `ProtectedPage`, `StartRoute`, Umleitung, Hinweisstreifen |
| `src/web/modules/serverProperties.ts` | Properties, Timeout, Retry, Backend-Requests |
| `src/web/modules/responseErrors.ts` | 401/403-Texte, zentrales Fehler-Logging |
| `src/main/java/…/resources/KeycloakInfoResource.java` | `GET /api/kc-config` (ungeschützt) |
| `src/main/java/…/provider/auth/Authenticator.java` | Request-Filter, 401/500 |
| `src/main/java/…/provider/auth/Secured.java` | NameBinding |
| `src/main/java/…/util/auth/KeycloakAuthUtil.java` | Signatur, Issuer, `azp`, `reactAuth`, JWKS-Cache |
| `src/main/java/…/util/KeycloakToken.java` | Lesehülle über die Claims |
| `src/main/java/…/util/JWTHelper.java` | Dekodieren **ohne** Prüfung — nur hinter dem Filter |
| `src/main/java/…/filters/CorsFilter.java` | Same-Origin und Loopback, sonst 403 |
| `src/main/java/…/JAXRSConfiguration.java` | explizite Registrierung, `@ApplicationPath("api")` |

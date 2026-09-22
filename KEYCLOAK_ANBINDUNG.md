# Keycloak-Anbindung in Seschat

> Lokale Lesedatei. Nicht committen, nicht pushen. Sie ist über `.git/info/exclude` lokal ausgeblendet.
>
> Stand: Seschat-Client `0.0.172`, `@11880/common-components` `0.44.4`, `keycloak-js` `24.0.2`.

---

## Inhalt

1. [Teil 1 – Die Anleitung: was passiert, wenn jemand die App aufruft](#teil-1--die-anleitung)
2. [Teil 2 – Codeerklärung: welches Modul was macht](#teil-2--codeerklärung)
3. [Teil 3 – Die zwei Berechtigungsprüfungen nach dem Rücksprung](#teil-3--die-zwei-berechtigungsprüfungen-nach-dem-rücksprung)
4. [Teil 4 – Wo genau ein Unberechtigter hängen bleibt](#teil-4--wo-genau-ein-unberechtigter-hängen-bleibt)
5. [Teil 5 – Konfiguration und lokale Entwicklung](#teil-5--konfiguration-und-lokale-entwicklung)
6. [Teil 6 – Stolperfallen und bewusste Entscheidungen](#teil-6--stolperfallen-und-bewusste-entscheidungen)

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

# Teil 2 – Codeerklärung

Reihenfolge wie im Ablauf. Jede Überschrift ist eine Datei.

## 2.1 Frontend-Start

### `Client/src/web/index.tsx`

Der Einstiegspunkt und zugleich die **Reihenfolge-Entscheidung** der ganzen Anbindung.

```
startEarlyConsoleCapture()      ← allererste Anweisung
createRoot(...).render(
  <StrictMode>
    <ErrorBoundary>            ← ÜBER Index, nicht darunter
      <Index />
```

`Index` selbst:

```tsx
const [config, configError] = useKeycloakConfig()
if (configError) return <StartupMessage … />
return config ? (
  <QueryClientProvider …>
    <KeycloakAuth config={config}>     {/* erst hier beginnt Keycloak */}
      <TooltipProvider>
        <ApiProvider>                  {/* erst hier der Berechtigungsabruf */}
          <App />                      {/* erst hier das Routing */}
```

Drei Dinge, die hier bewusst so stehen:

* **`KeycloakAuth` kann erst nach dem Config-Fetch gerendert werden**, weil `keycloak-js` die Konfiguration im Konstruktor braucht. Deshalb der zweistufige Start mit dem Spinner dazwischen.
* **Die `ErrorBoundary` steht über `Index`.** Als Kind wäre `useKeycloakConfig` ungeschützt und ein Wurf dort ergäbe eine weiße Seite — also genau im Startfall, für den die Boundary da ist.
* **`startEarlyConsoleCapture()` ganz oben** sammelt die Konsolenausgaben, die vor dem Effekt in `App.tsx` anfallen — das sind Keycloak-Init und Config-Laden. Aber: geleert wird der Puffer erst von `startConsoleLogForwarding`, und das braucht ein Token. Ein **Totalausfall beim Anmelden landet daher nie im Serverlog**. Das ist so gewollt und nicht änderbar — ohne Token nimmt der Server keine Logs an.

### `Client/src/web/modules/api.ts`

Klein, aber es legt drei Dinge fest:

```ts
export const contextRoot = 'Seschat'
const pageOrigin = typeof window === 'undefined' ? '' : window.location.origin
export const appRoot = `${pageOrigin}/${contextRoot}`
```

`appRoot` ist **immer die Herkunft der ausgelieferten Seite** — nie eine fest verdrahtete Adresse. Früher stand hier für die Entwicklung die IP des Testservers; die gehört nicht in den Quellcode und liegt heute nur noch im Git-Verlauf.

`useKeycloakConfig` ist ein Hook mit `useState`/`useEffect` (kein React Query — der Query-Client steht zu diesem Zeitpunkt noch nicht):

```ts
const loadKeycloakConfig = () =>
  useEnvKeycloakConfig
    ? Promise.resolve(getEnvKeycloakConfig())
    : request<Keycloak.KeycloakConfig>(`${appRoot}/api/kc-config`)
```

Der `env`-Zweig greift nur bei `NODE_ENV !== 'production'` **und** `DEV_KEYCLOAK_CONFIG_SOURCE=env` in `Client/.env`. In der gebauten Version ist er tot.

`StrictMode` führt lokal zu zwei Aufrufen von `/api/kc-config`. Das ist bewusst in Kauf genommen — der GET ist idempotent.

## 2.2 Die Library: `@11880/common-components`

Die Quelle liegt als kompiliertes ESM unter
`Client/node_modules/@11880/common-components/dist/components/app/keycloak/KeycloakAuth.js`.
Der Typvertrag steht in `dist/components/app/app.d.ts`.

### `KeycloakAuth` — Zustand

Die Komponente hält drei Dinge im State und eines in einer Ref:

```js
const [error, setError] = useState('')          // Startfehler als Text
const [instance, setInstance] = useState()      // die Keycloak-Instanz
const [tokenParsed, setTokenParsed] = useState()// der dekodierte Token-Inhalt
const busy = useRef(false)                      // Doppelstart-Sperre
```

Die `busy`-Ref ist die Antwort auf `StrictMode`: React ruft Effekte im Entwicklungsmodus doppelt auf, und ein zweiter `keycloak.init()` auf derselben Seite würde den Callback ein zweites Mal einlösen wollen — der Code ist dann schon verbraucht.

### `KeycloakAuth` — `initKeycloak`

```js
const keycloak = new Keycloak(props.config)
const authenticated = await keycloak.init({
  onLoad: 'login-required',
  checkLoginIframe: false,
  ...props.initOptions
})
if (!authenticated) throw 'User couldn\'t authenticate with Keycloak'
keycloak.onAuthRefreshSuccess = () => console.log('Keycloak auth refreshed')
setInstance(keycloak)
setTokenParsed(keycloak.tokenParsed)
```

Seschat übergibt **kein** `initOptions`, es gelten also die beiden Vorgaben:

* `onLoad: 'login-required'` — sofort umleiten statt still probieren.
* `checkLoginIframe: false` — keine periodische Iframe-Prüfung gegen Keycloak. Das spart den Dauer-Traffic und umgeht die Third-Party-Cookie-Problematik moderner Browser. Der Preis: Wird die SSO-Sitzung woanders beendet, merkt Seschat das erst beim nächsten fehlschlagenden Refresh.

Scheitert `init`, wird kein Fehler geworfen, sondern `error` gesetzt → die Komponente rendert „Fehler beim Login“. Die App startet nicht.

### `KeycloakAuth` — `getAuthorization`

Das ist die Funktion, die im ganzen Projekt vor jedem Request steht:

```js
const getAuthorization = useCallback(async (minValidity = 5) => {
  if (!instance) throw new Error('Keycloak client is not initialized.')
  try {
    const authChanged = await instance.updateToken(minValidity)
    if (authChanged) setTokenParsed(instance.tokenParsed)
  } catch (err) {
    await instance.login()
    throw new Error('Login didn\'t redirected.')
  }
  return 'Bearer ' + instance.token
}, [instance])
```

Drei Punkte, die man kennen muss:

* **Es gibt keinen Token-Getter ohne Aktualisierung.** Man kann in dieser Architektur gar kein abgelaufenes Token verschicken, solange man `getAuthorization()` benutzt (und das tun alle Helfer).
* **`setTokenParsed` bei Wechsel** sorgt dafür, dass Name, Personalnummer und `reactAuth` nach einem Refresh aktuell sind. Ändert Keycloak den Status auf 1 oder 2, fliegt der Nutzer beim nächsten Refresh in die Sperrseite — ohne Reload.
* **Scheitert der Refresh, wird umgeleitet, nicht zurückgegeben.** Der geworfene Fehler („Login didn't redirected“) ist nur der Fall, dass der Redirect nicht gegriffen hat.

### `KeycloakAuth` — die Torwächter-Logik

Das ist der Kern für Stufe B:

```js
const contextValue = useMemo(() => {
  if (!instance || !tokenParsed) return null
  return {
    instance,
    tokenParsed,
    permission: tokenParsed.reactAuth ?? { status: -1, uidspx: null, berechtigungsobjekt: {} },
    getAuthorization,
  }
}, [instance, tokenParsed, getAuthorization])
```

Fehlt der Claim komplett, entsteht ein Ersatzobjekt mit `status: -1` — **nicht** mit 0. Der Default ist also „gesperrt“, nicht „offen“. Das ist die richtige Richtung und der Grund, warum ein Token ohne `reactAuth` nicht durchrutscht.

Und die Ausgabe:

```js
return permission.status === 0
  ? <keycloakContext.Provider value={contextValue}>{props.children}</keycloakContext.Provider>
  : permission.status === 1 ? <CenterContainerWithLogo><UserUnauthorized …/></CenterContainerWithLogo>
  : permission.status === 2 ? <CenterContainerWithLogo><UserEvict …/></CenterContainerWithLogo>
  : <div>Ein unbekannter Fehler ist aufgetreten</div>
```

**`props.children` wird bei allem außer `status === 0` überhaupt nicht gerendert.** Der `ApiProvider` läuft nicht, `App` läuft nicht, es wird kein einziger Fachrequest abgesetzt. Das ist kein CSS-Ausblenden, der Baum existiert nicht.

### `useKeycloak` — die zweite Absicherung

```js
export const useKeycloak = () => {
  const value = useContext(keycloakContext)
  if (!value) throw new Error('useKeycloak may only be used in children of KeycloakAuth')
  if (value.permission.status !== 0) throw new Error('User is not authorized to use this application.')
  return value
}
```

Die zweite Zeile ist im Normalfall unerreichbar (der Provider wird bei ≠0 ja nicht gerendert). Sie ist die Rückfallebene für den Fall, dass jemand den Context später anders verdrahtet. Der Typ `KeycloakContext.permission` ist entsprechend auf `Extract<Permissions, { status: 0 }>` verengt — im TypeScript-Sinn gibt es unterhalb von `useKeycloak` also gar keinen unzulässigen Status mehr.

### `UserUnauthorized` / `UserEvict`

Beides reine Anzeigekomponenten unter `dist/components/app/notices/`.

* `UserUnauthorized` (status 1): „User <name> ist nicht zur Nutzung dieser Anwendung berechtigt“ plus Link „Aus allen Anwendungen abmelden“. Der Link ist für den Fall gedacht, dass man mit einem falschen Testnutzer angemeldet ist.
* `UserEvict` (status 2): dieselbe Aussage für *interne Anwendungen allgemein*, plus `useState(10)` und ein `setTimeout`-Countdown, der nach Ablauf `logout()` aufruft. Der Nutzer wird also aktiv hinausgeworfen.

### `Navigation`

`dist/components/app/navigation/Navigation.js` — bemerkenswert unspektakulär:

```js
const Navigation = ({ menu, loginName, heading, userMenu, logout, children }) => (
  <div className="nav-layout">
    <div className="nav-content"><Outlet />{children}</div>
    <NavMenu menu={menu} heading={heading} loginName={loginName} userMenu={userMenu} logout={logout} />
  </div>
)
```

Die Navigation kennt **keine** Berechtigungen. Sie rendert genau das `menu`-Array, das sie bekommt. Die Filterung passiert vorher in `buildRbacMenu`. Das ist bewusst so: Die Library ist für mehrere Anwendungen da und soll keine Seschat-Rollen kennen.

## 2.3 `keycloak-js` 24.0.2 im Detail

Datei: `Client/node_modules/keycloak-js/dist/keycloak.mjs` (1759 Zeilen, unkomprimiert lesbar). Die relevanten Stellen:

### `init()` — Voreinstellungen (Zeilen ~44–180)

```js
var useNonce = true;                 // Zeile 48
…
if (initOptions.pkceMethod) { … } else { kc.pkceMethod = "S256"; }        // Zeile 136–142
if (!kc.responseMode) kc.responseMode = 'fragment';                       // Zeile 172
if (!kc.responseType) { kc.responseType = 'code'; kc.flow = 'standard'; } // Zeile 175
```

Das ist der Punkt, den man kennen sollte: **PKCE ist in Version 24 der Default**, nicht etwas, das Seschat einschaltet. Ebenso Nonce und der Authorization-Code-Flow mit Fragment-Response.

### `createLoginUrl()` (Zeile 401)

```js
var state = createUUID();
var nonce = createUUID();
var redirectUri = adapter.redirectUri(options);
var callbackState = { state, nonce, redirectUri: encodeURIComponent(redirectUri) };
…
if (kc.pkceMethod) {
  var codeVerifier = generateCodeVerifier(96);
  callbackState.pkceCodeVerifier = codeVerifier;
  url += '&code_challenge=' + generatePkceChallenge(kc.pkceMethod, codeVerifier);
  url += '&code_challenge_method=' + kc.pkceMethod;
}
callbackStorage.add(callbackState);
```

`generateRandomData` nimmt `window.crypto.getRandomValues`, wenn vorhanden, sonst `Math.random` als Notnagel. In jedem hier relevanten Browser greift der Krypto-Zweig.

### `parseCallback()` / `parseCallbackUrl()` (Zeilen 1052 und 1071)

```js
function parseCallback(url) {
  var oauth = parseCallbackUrl(url);
  if (!oauth) return;
  var oauthState = callbackStorage.get(oauth.state);   // hier wird state geprüft
  if (oauthState) {
    oauth.valid = true;
    oauth.redirectUri = oauthState.redirectUri;
    oauth.storedNonce = oauthState.nonce;
    oauth.prompt = oauthState.prompt;
    oauth.pkceCodeVerifier = oauthState.pkceCodeVerifier;
  }
  return oauth;
}
```

`callbackStorage.get(state)` **entfernt den Eintrag beim Lesen** (`localStorage.removeItem` direkt nach dem `getItem`). Ein Callback lässt sich also genau einmal verwenden — ein zurückgespieltes Fragment aus der History findet keinen `state` mehr und ist damit `valid === false`.

`parseCallbackUrl` liest nur eine **feste Liste** erlaubter Parameter (`code`, `state`, `session_state`, `kc_action_status`, `iss`, `error*`). Alles andere bleibt unangetastet in der URL stehen — deshalb überlebt ein eigener Query-String den Rücksprung.

### `processInit()` (Zeile 817)

```js
var callback = parseCallback(window.location.href);
if (callback) {
  window.history.replaceState(window.history.state, null, callback.newUrl);   // URL putzen
}
if (callback && callback.valid) {
  return setupCheckLoginIframe().then(() => processCallback(callback, initPromise))
} else if (initOptions) { /* … onLoad() … */ }
```

Reihenfolge merken: **erst putzen, dann prüfen**. Selbst ein ungültiger Callback hinterlässt keine Spur in der Adresszeile.

### `processCallback()` (Zeile 743)

Der Code-gegen-Token-Tausch, als klassischer `XMLHttpRequest`:

```js
var params = 'code=' + code + '&grant_type=authorization_code';
params += '&client_id=' + encodeURIComponent(kc.clientId);
params += '&redirect_uri=' + oauth.redirectUri;
if (oauth.pkceCodeVerifier) params += '&code_verifier=' + oauth.pkceCodeVerifier;
req.withCredentials = true;
```

Kein `client_secret` — Seschat ist ein Public Client, die Absicherung leistet PKCE.

Und danach, in `authSuccess`:

```js
setToken(accessToken, refreshToken, idToken, timeLocal);
if (useNonce && (kc.idTokenParsed && kc.idTokenParsed.nonce != oauth.storedNonce)) {
  logInfo('[KEYCLOAK] Invalid nonce, clearing token');
  kc.clearToken();
  promise && promise.setError();
}
```

Nonce-Abgleich als letzter Schritt. Passt sie nicht, ist das Token sofort wieder weg.

`timeLocal` wird als Mittelwert von Sende- und Empfangszeit gesetzt und dient später als `timeSkew` — deshalb funktioniert die Ablaufprüfung auch bei einer schief gehenden Client-Uhr.

### `updateToken(minValidity)` (Zeile 626)

```js
if (!kc.refreshToken) { promise.setError(); return promise.promise; }
minValidity = minValidity || 5;
…
if (minValidity == -1) refreshToken = true;
else if (!kc.tokenParsed || kc.isTokenExpired(minValidity)) refreshToken = true;
if (!refreshToken) { promise.setSuccess(false); }   // false = nichts geändert
else { /* … refreshQueue.push(promise); … */ }
```

Die `refreshQueue` ist wichtig: Wenn zehn Requests gleichzeitig `getAuthorization()` rufen und das Token gerade abläuft, geht **ein** Refresh-Request raus und alle zehn Promises werden aus derselben Antwort bedient. Ohne das würde Seschat beim Laden der Buchhaltungsseite Keycloak mit parallelen Refreshes beschießen.

Bei HTTP 400 auf den Refresh (ungültiges Refresh-Token) wird `clearToken()` gerufen; das setzt bei `kc.loginRequired` direkt einen neuen Login an.

### `isTokenExpired()` (Zeile 606)

```js
if (kc.timeSkew == null) { logInfo('… timeskew is not set'); return true; }
var expiresIn = kc.tokenParsed['exp'] - Math.ceil(Date.now()/1000) + kc.timeSkew;
if (minValidity) expiresIn -= minValidity;
return expiresIn < 0;
```

Unbekannter Zeitversatz heißt „abgelaufen“ — wieder der sichere Default.

### Callback-Speicher (Zeilen 1625–1741)

`LocalStorage` ist der Normalfall; der Konstruktor testet mit `kc-test` und wirft, wenn localStorage blockiert ist — dann greift `CookieStorage`. Beide räumen abgelaufene `kc-callback-*`-Einträge auf (localStorage: 1 Stunde, Cookie: 60 Minuten).

**Merke:** In `kc-callback-<state>` steht der `code_verifier` im Klartext im localStorage. Das ist der vorgesehene Weg für Public Clients im Browser — er ist nur wenige Sekunden lang relevant (zwischen Login-Redirect und Token-Tausch) und wird beim Lesen gelöscht. Die **Tokens** selbst liegen dort nie.

## 2.4 Die App-seitige Berechtigung

### `Client/src/web/hooks/useCurrentUserPermissions.ts`

Der Hook, der Stufe C mit Daten versorgt.

```ts
const fetchCurrentUserPermissions = async (getAuthorization, signal) => {
  const authorization = await getAuthorization()
  const [backendRoot, permissionsPath, requestSettings] = await Promise.all([
    fetchServerProperty('backend-root', signal, authorization),
    fetchServerProperty('current-user.permissions-path', signal, authorization),
    fetchBackendRequestSettings(signal, authorization),
  ])
  const response = await fetchBackendResponse(backendRoot, permissionsPath, requestSettings, {
    headers: { Accept: 'application/json', Authorization: authorization },
  }, signal)
  if (!response.ok) throw await createApiResponseError(response, `GET ${permissionsPath} fehlgeschlagen (${response.status}).`)
  return readPermissionsPayload(response)
}
```

Beachtenswert:

* **Der Pfad ist nicht hartkodiert.** `current-user.permissions-path` kommt aus den Server-Properties (Default `/user/berechtigung`, überschreibbar über `seschat.current.user.permissions.path`). Das ist die generelle Projektregel: keine Backend-Pfade im Frontend-Code.
* **Das Token wird einmal geholt und für alle Requests verwendet.** `getAuthorization()` hat oben schon für Gültigkeit gesorgt.
* Der Query läuft mit `retry: 1`, `refetchOnWindowFocus: false` und `staleTime: 5 min`. Die Berechtigung wird also nicht bei jedem Fensterwechsel neu geholt, aber nach fünf Minuten beim nächsten Anlass.

Die Validierungskette darunter ist konsequent misstrauisch:

```ts
validateResponseStatus(payload)   // errorcode_http muss 200, errorcode_intern muss OK sein
readAuthorizationPayload(payload) // 'data' muss existieren
validateCurrentUserAuthorization(data)
```

Ein Backend, das `200` mit einer Fehlerhülle im Rumpf zurückgibt, kommt hier nicht durch. Ein leerer Rumpf auch nicht („Berechtigungsantwort ist leer.“). Ein `SyntaxError` beim Parsen wird in eine lesbare Meldung übersetzt, **alle anderen Fehler werden durchgereicht** — die Validierungsfehler aus `rbac.ts` sollen den Nutzer ja erreichen.

### `Client/src/web/modules/rbac.ts`

Die reine Logik, ohne React, deshalb komplett testbar (`rbac.test.ts`).

Die Datenmodelle:

```ts
type CurrentUserRole = 'ADMIN' | 'BUCHHALTUNG' | 'ANWENDER'
type ProtectedArea   = 'admin' | 'buchhaltung' | 'anwender'
```

Die Abbildung:

```ts
const AREA_ACCESS = [
  { area: 'admin',       role: 'ADMIN' },
  { area: 'buchhaltung', role: 'BUCHHALTUNG' },
  { area: 'anwender',    role: 'ANWENDER' },
]
```

Die vier Funktionen, die `App.tsx` benutzt:

| Funktion | Rückgabe |
|---|---|
| `getAllowedAreas(auth)` | Liste der erlaubten Bereiche; `[]` wenn `auth` `undefined` ist |
| `buildRbacMenu(auth)` | die Menüeinträge zu genau diesen Bereichen |
| `hasAreaAccess(auth, area)` | ob `area` in der Liste steht |
| `getFirstAllowedPath(auth)` | der erste erlaubte Pfad oder `null` |

Alle vier laufen über `getAllowedAreas`, und das gibt bei `undefined` eine leere Liste zurück. **Ohne geladene Berechtigung ist also alles gesperrt und `getFirstAllowedPath` ist `null`** — genau darauf stützt sich `ProtectedPage`.

`normalizeRole` wirft bei unbekannten Werten:

```ts
const normalizeRole = (value: unknown): CurrentUserRole => {
  const role = String(value).trim().toUpperCase()
  if (KNOWN_ROLES.includes(role as CurrentUserRole)) return role as CurrentUserRole
  throw new Error(`Unbekannte Rolle: ${String(value)}`)
}
```

Kein Ignorieren, kein Überspringen. Eine unbekannte Rolle in der Antwort macht die **ganze** Berechtigung ungültig, und der Nutzer sieht das Sperrpanel. Das ist die strengere von zwei möglichen Auslegungen und hier die richtige: Eine neue Rolle im Backend, die das Frontend nicht kennt, darf nicht stillschweigend als „keine Rechte“ durchgehen und auch nicht als irgendetwas anderes.

`ROLE_CONFLICTS` verbietet `BUCHHALTUNG`+`ANWENDER` und `ADMIN`+`ANWENDER`. Diese Prüfung gilt in beide Richtungen: beim Lesen der Berechtigung (`validateCurrentUserAuthorization`) und beim Setzen in der Benutzerverwaltung (`updateRoleSelection`, `getRoleCombinationError`).

`readFirmierungen` führt außerdem doppelte Firmierungen zusammen: Kommt dieselbe Firmierungs-UUID mehrfach mit unterschiedlichen Fachbereichen, entsteht ein Eintrag mit der Vereinigung der Fachbereiche, dedupliziert über `lnk_seschat_firmierung_fachbereich_uuid`.

### `Client/src/web/providers/ApiProvider.tsx`

Die Klammer zwischen Keycloak-Context und App.

```tsx
const { tokenParsed, getAuthorization } = useKeycloak()
const { given_name, family_name, employeeNumber } = tokenParsed
```

Er macht drei Dinge:

1. **Server-Properties vorladen** und daraus `logging.client.min-level` setzen — mit Token, wie alles andere auch.
2. **`useCurrentUserPermissions()` aufrufen** und Daten, Fehler, Ladezustand und `refetch` in den Context legen. Das ist die einzige Stelle, an der die Berechtigung geholt wird; `App.tsx` liest sie über `useApi()`.
3. **Logging** (`/api/Logger`, `/api/LoggerBatch`) — ebenfalls mit `await getAuthorization()` pro Request.

Zwei Logzeilen erklären später den halben Support:

```ts
rbacLog.info('berechtigungen geladen', {
  rollen: permissions.rollen.join(','),
  bereiche: getAllowedAreas(permissions).join(',') || 'keine',
  firmierungen: permissions.firmierung.length,
})
rbacLog.warn('berechtigungen konnten nicht geladen werden', error)
```

Ein `warn`, kein `error` — die App zeigt dem Nutzer ein Panel mit „Erneut laden“, sie ist nicht kaputt. Genau die Unterscheidung, die in `CLAUDE.md` festgelegt ist.

### `Client/src/web/components/App.tsx`

Hier wird die Berechtigung zu sichtbarem Verhalten.

**`ProtectedPage`** (Zeile 123) — die Wache, mit den Fällen in fester Reihenfolge:

```tsx
const guard = [
  { active: isLoading,
    render: () => <PermissionLoadingPage /> },
  { active: Boolean(error || !authorization),
    render: () => <AuthorizationErrorPanel error={error} onRetry={onRetry} /> },
  { active: Boolean(authorization && !hasAreaAccess(authorization, area)),
    render: () => fallbackPath
      ? <AccessDeniedRedirect area={area} fallbackPath={fallbackPath} />
      : <AuthorizationErrorPanel error={null} onRetry={onRetry} /> },
].find(item => item.active)

return guard ? guard.render() : <>{children}</>
```

Die Reihenfolge ist die Aussage: Laden schlägt Fehler, Fehler schlägt Rollenprüfung, und erst wenn **keiner** der drei Fälle greift, wird `children` gerendert. Es gibt keinen Pfad, auf dem ein Bereich ohne geprüfte Rolle sichtbar wird. Und `!authorization` — also „gar nichts geladen“ — führt in dasselbe Panel wie ein echter Fehler.

**`AccessDeniedRedirect`** (Zeile 115) ist bewusst eine eigene Komponente:

```tsx
useEffect(() => { log.warn('bereich gesperrt', undefined, { area, ziel: fallbackPath }) }, [area, fallbackPath])
return <Navigate to={fallbackPath} replace state={{ accessDenied: true }} />
```

Als Inline-Code stünde das `log.warn` im Render und liefe pro Render erneut — die Zeile entsteht so genau einmal pro Umleitung. `replace` sorgt dafür, dass der gesperrte Pfad nicht in der History landet (sonst käme man mit „Zurück“ in eine Schleife).

**`RouteAccessNotice`** liest `location.state.accessDenied` und zeigt den gelben Hinweisstreifen. Die Anzeigedauer kommt aus der Server-Property `route-access-notice.duration-ms` (Default 20 000 ms), und der Wert wird beim ersten Anzeigen in einer Ref eingefroren, damit ein nachträglich eintreffender Property-Wert den laufenden Timer nicht verkürzt. Danach navigiert sie mit `replace` und `state: null` auf denselben Pfad — der Hinweis verschwindet, ohne dass sich sonst etwas ändert.

**`StartRoute`** für `/`: lädt → Spinner, Fehler **oder** kein `fallbackPath` → Panel, sonst `<Navigate to={fallbackPath}>`. Ein Nutzer ohne jede Rolle kommt hier bis zum Panel und nicht weiter — das ist der Fall, den `validateCurrentUserAuthorization` mit „Der Benutzer hat keine gültige Rolle.“ ohnehin schon als Fehler erzeugt hat.

**Der Catch-all** ganz unten:

```tsx
<Route path="*" element={<Navigate to={firstAllowedPath ?? '/'} replace />} />
```

Jeder unbekannte Pfad landet im ersten erlaubten Bereich — oder auf `/`, was wieder in `StartRoute` läuft.

**Die Adminunterseiten** (`benutzerverwaltung`, `fachbereiche`, …) sind verschachtelte Routen unter `/admin`. Sie brauchen keine eigene `ProtectedPage`, weil die Elternroute nur bei bestandener Prüfung überhaupt ein `<Outlet>` rendert.

**Die Anleitung** ist ein Sonderfall:

```tsx
area={getAllowedAreas(currentUserPermissions)[0] ?? 'admin'}
```

Sie prüft gegen den *ersten erlaubten* Bereich — also gegen etwas, das definitionsgemäß erlaubt ist, wenn überhaupt eine Rolle da ist. Der Fallback `'admin'` greift nur bei leerer Liste und sperrt dann zuverlässig. Der Inhalt selbst richtet sich über `getGuidePathForLocation(allowedAreas, …)` nach den erlaubten Bereichen.

### `Client/src/web/modules/serverProperties.ts`

Die Transportschicht. Für die Keycloak-Frage sind drei Dinge relevant:

* **Jeder Aufruf bekommt `authorization` als Parameter durchgereicht** — es gibt keinen globalen Token-Zugriff in diesem Modul. Das macht es testbar und verhindert, dass irgendwo ein veraltetes Token aus einer Closure verwendet wird.
* `fetchServerProperties` **cached** die Properties (Default 5 Minuten, überschreibbar über `all-properties.stale-time-ms`) und bündelt gleichzeitige Anfragen in einem einzigen laufenden Promise.
* Property-Reads geben **absichtlich kein Abort-Signal** an `fetch` weiter (siehe `CLAUDE.md`): Sonst erscheinen lokale Dev-Requests wie `backend-root` während des Auth- und Render-Geruckels als „canceled“.

`fetchBackendResponseAttempt` wiederholt GET/HEAD/OPTIONS bei 408, 429 und 5xx. **401 und 403 werden nicht wiederholt** — das wäre sinnlos, weil sich an der Berechtigung durch einen zweiten Versuch nichts ändert.

### `Client/src/web/modules/responseErrors.ts`

Der Trichter für alle fehlgeschlagenen Antworten. Für Auth relevant:

```ts
const STATUS_MESSAGES: Record<number, string> = {
  401: 'Ihre Sitzung ist abgelaufen. Bitte laden Sie die Seite neu und melden Sie sich erneut an.',
  403: 'Sie haben keine Berechtigung für diese Aktion.',
}
```

Der Statustext **gewinnt** gegen die Backendmeldung, weil die zu 401/403 oft technisch ist und dem Nutzer nichts sagt. Geloggt wird beides als `warn`, nicht `error` — abgelaufene Sitzungen sind Normalbetrieb und würden das ERROR-Log sonst zumüllen.

## 2.5 Das WAR-Backend (JAX-RS)

### `JAXRSConfiguration.java`

```java
@ApplicationPath("api")
public class JAXRSConfiguration extends Application {
    @Override public Set<Class<?>> getClasses() {
        return Set.of(CorsFilter.class, Authenticator.class,
                      GenericExceptionMapper.class, APIResource.class, KeycloakInfoResource.class);
    }
}
```

Alles wird **explizit** registriert. Auf Auto-Discovery wird bewusst verzichtet (steht auch so in `CLAUDE.md`) — bei CORS hat das in der Vergangenheit für Überraschungen gesorgt.

### `KeycloakInfoResource.java` — `GET /Seschat/api/kc-config`

Die einzige **ungeschützte** Ressource, und das muss so sein: Ohne sie weiß der Client nicht, gegen welchen Keycloak er sich anmelden soll. Sie trägt kein `@Secured`.

```java
String url = System.getProperty("auth.keycloak.root.seschat");
if (url == null) url = System.getProperty("auth.keycloak.root");
if (url == null) throw new MissingConfigurationException("Keycloak Root property isn't set.");
```

Das Muster `<property>.seschat` vor `<property>` erlaubt es, auf einem WildFly mit mehreren Anwendungen eine anwendungsspezifische Keycloak-Anbindung zu setzen, ohne die gemeinsame zu verbiegen. Fehlt eine Pflicht-Property, kommt `500` und im Serverlog steht `SEVERE: Missing Keycloak system property.`

Preisgegeben werden nur `url`, `realm` und `clientId` — bei einem Public Client sind das öffentliche Werte. Kein Secret, keine interne Adresse.

### `Secured.java`

```java
@NameBinding
@Target({ TYPE, METHOD })
@Retention(RUNTIME)
public @interface Secured {}
```

Ein JAX-RS-NameBinding, sonst nichts. Es verbindet den `Authenticator` mit den Ressourcen, die ihn brauchen. `APIResource` trägt `@Secured` auf Klassenebene, `KeycloakInfoResource` nicht.

### `Authenticator.java` — der Request-Filter

```java
@Secured @Provider @Priority(Priorities.AUTHENTICATION)
public class Authenticator implements ContainerRequestFilter {
  @Context private HttpServletRequest request;

  @Override public void filter(ContainerRequestContext requestContext) {
    if (request.getMethod().equals(HttpMethod.OPTIONS)) return;                  // (1)
    try {
      final DecodedJWT jwt = KeycloakAuthUtil.verifyRequest(request);
      request.setAttribute("auth.keycloak.token", KeycloakToken.of(jwt));        // (2)
    } catch (UnauthorizedRequestException e) {
      LOGGER.warnf("Unauthorized Request from %s - %s", request.getRemoteAddr(), e.getMessage());
      requestContext.abortWith(Response.status(UNAUTHORIZED)/* … */);            // (3)
    } catch (InternalVerificationException e) {
      LOGGER.error("Authentication error", e);
      requestContext.abortWith(Response.serverError()/* … */);                   // (4)
    }
  }
}
```

1. **OPTIONS geht durch.** Ein CORS-Preflight trägt per Definition keinen `Authorization`-Header; würde man ihn ablehnen, käme der eigentliche Request nie zustande. Der `CorsFilter` beantwortet ihn danach.
2. **Das geprüfte Token wird als Request-Attribut abgelegt**, damit Ressourcen es lesen können, ohne noch einmal zu parsen.
3. **Nutzerfehler → 401** mit `text/plain` und deutschem Text. Geloggt als `warn` mit IP und Grund — nicht als `error`, weil ein abgelaufenes Token Normalbetrieb ist.
4. **Serverfehler → 500.** Die Trennung ist wichtig: Ein nicht erreichbarer Keycloak ist kein „du darfst nicht“, sondern „wir können gerade nicht prüfen“, und darf nicht als Berechtigungsproblem im Log erscheinen.

**Der wichtigste Punkt:** Weder Stack noch Exception-Text landen beim Client. Der Nutzer erfährt nur, dass es nicht ging.

### `KeycloakAuthUtil.java` — die eigentliche Prüfung

`verifyRequest` → `readAuthorizationHeader` → `parseAuthString` → `verifyJWT`.

**`readAuthorizationHeader`**: liest erst den Header, dann als Rückfall den **Query-Parameter** `Authorization`. Der Query-Weg existiert für Fälle, in denen kein Header gesetzt werden kann (Download-Links, `<img src>`). Er ist die schwächere Variante — Query-Strings landen in Zugriffslogs — und sollte für neue Endpunkte nicht verwendet werden. Auf der Frontend-Seite gibt es dazu die passende Regel: `pathOnly` in `modules/logger.ts` kappt jede geloggte URL am `?`.

**`parseAuthString`**:

```java
final StringTokenizer st = new StringTokenizer(authorization, " ");
if (st.countTokens() != 2) throw new UnauthorizedRequestException("Malformed Authorization string.");
if (!st.nextToken().equalsIgnoreCase("bearer")) throw new UnauthorizedRequestException("… doesn't specify type \"Bearer\".");
return st.nextToken();
```

Genau zwei Token, Typ case-insensitiv `bearer`. Alles andere fliegt raus.

**`verifyJWT`** — der Kern:

```java
final Config config = getConfig();
final DecodedJWT jwt = decodeTokenString(encodedJWT);
final String issuer = buildRealmUrl(config);
final Jwk jwk = jwkProviderFor(issuer).get(jwt.getKeyId());
final Algorithm rsa256 = Algorithm.RSA256((RSAPublicKey) jwk.getPublicKey(), null);
final JWTVerifier verifier = JWT.require(rsa256)
        .withIssuer(issuer)
        .withClaim("azp", (azp, djwt) -> config.authorizedClients.contains(azp.asString()))
        .withClaim("reactAuth", (reactAuth, djwt) -> (Integer) reactAuth.asMap().getOrDefault("status", -1) == 0)
        .acceptLeeway(5)
        .build();
return verifier.verify(jwt);
```

Fünf Prüfungen in einer Kette:

| Prüfung | Wogegen sie schützt |
|---|---|
| `Algorithm.RSA256(publicKey, null)` | Gefälschte oder veränderte Tokens. Der zweite Parameter `null` ist der private Schlüssel — der Server signiert nicht, er prüft nur. Der Algorithmus ist **fest** RS256, es wird nichts aus dem Token-Header übernommen (kein `alg: none`-Angriff). |
| `jwt.getKeyId()` + JWKS | Schlüsselrotation. Die `kid` wählt den passenden öffentlichen Schlüssel; einen unbekannten holt der Provider nach. |
| `.withIssuer(issuer)` | Tokens aus einem fremden Realm oder Keycloak. |
| `.withClaim("azp", …)` | Tokens, die ein **anderer Client** desselben Realms ausgestellt bekommen hat. Ohne diese Prüfung könnte sich jemand ein Token für eine beliebige andere 11880-Anwendung holen und damit Seschat ansprechen. |
| `.withClaim("reactAuth", … status == 0)` | Nutzer, die für die Anwendung gesperrt sind — **serverseitig**, nicht nur im UI. Das ist die Antwort auf „was, wenn jemand die Frontend-Prüfung umgeht“. |

`.acceptLeeway(5)` erlaubt 5 Sekunden Uhrendrift bei `exp`/`nbf`/`iat`, passend zum `minValidity = 5` auf der Clientseite.

Der `getOrDefault("status", -1)`-Default ist wieder „gesperrt“: Ein Token ohne `reactAuth` fällt durch.

**Das Exception-Mapping** trennt sauber zwischen Nutzer- und Serverfehler:

```
JWTDecodeException             → Unauthorized "Malformed JWT in Authorization."
TokenExpiredException          → Unauthorized "Auth token expired."
SignatureVerificationException → Unauthorized "Token signature is invalid."
JWTVerificationException       → Unauthorized "… Signature or issuer is invalid or reactAuth is negative."
Exception                      → InternalVerificationException
```

Die Reihenfolge ist entscheidend: `TokenExpiredException` und `SignatureVerificationException` sind Unterklassen von `JWTVerificationException` und müssen davor stehen, sonst wäre die Meldung immer dieselbe.

**Der JWKS-Provider** ist der Teil, an dem schon einmal etwas repariert wurde — der Kommentar im Code sagt es deutlich:

```java
private static final Map<String, JwkProvider> JWK_PROVIDERS = new ConcurrentHashMap<>();
private static final long JWK_CACHE_SIZE = 10;
private static final long JWK_CACHE_HOURS = 24;
private static final long JWK_REQUESTS_PER_MINUTE = 10;
private static final int  JWK_TIMEOUT_MS = 5_000;
```

Vorher wurde der Provider **pro Request** gebaut. Das bedeutete: kein Cache, kein Rate-Limit und — das Schlimmste — keine Timeouts. Ein langsamer oder nicht erreichbarer Keycloak konnte Server-Threads unbegrenzt binden. Jetzt gibt es einen Provider pro Issuer für die Lebensdauer der Anwendung, 24 Stunden Cache, maximal 10 JWKS-Abrufe pro Minute (damit eine erfundene `kid` den Keycloak nicht fluten kann) und 5 Sekunden Timeout.

`buildRealmUrl` schneidet einen abschließenden Schrägstrich ab, damit `https://kc/` und `https://kc` denselben Issuer ergeben — sonst schlägt `withIssuer` bei einer harmlosen Konfigurationsvariante fehl.

`getConfig` liest `seschat.authorized_clients` als `;`-getrennte Liste und **trimmt** jeden Eintrag. Auch das ist eine reparierte Falle: `"client1; client2"` hätte sonst einen Client mit führendem Leerzeichen ergeben, der nie auf `azp` passt.

### `KeycloakToken.java`

Eine Lesehülle um das geprüfte `DecodedJWT`, damit Ressourcen nicht mit Claim-Strings hantieren:

```java
private Map<String, Object> getReactAuth() {
    final Map<String, Object> reactAuth = jwt.getClaim("reactAuth").asMap();
    return reactAuth != null ? reactAuth : Map.of();      // nie null
}
```

Der Kommentar erklärt den Grund: `asMap()` gibt bei fehlendem Claim `null` zurück, und **jede** nachfolgende Abfrage würde bei einem gültig signierten Token ohne diesen Claim in eine NPE laufen. `getPermissions()` gibt konsequent `List.of()` statt `null` zurück — „keine Rechte“ ist ein Wert, kein Fehler.

Getter: `getEmployeeNumber`, `getUidspx`, `getUsername`, `getEmail`, `getFirstName`, `getLastName`, `getBerechtigungsobjekt`, `getUsergruppenobjekt`, `getPermissions`.

### `JWTHelper.java`

```java
public static DecodedJWT decodeRequestAuth(final HttpServletRequest request) {
    try {
        return decodeTokenString(KeycloakAuthUtil.parseAuthString(KeycloakAuthUtil.readAuthorizationHeader(request)));
    } catch (UnauthorizedRequestException | JWTDecodeException ex) {
        return null;
    }
}
```

**Achtung — hier wird nur dekodiert, nicht geprüft.** Der Javadoc sagt es: nur für Requests benutzen, deren Autorisierung der `Authenticator` bereits geprüft hat. Der Helfer nutzt inzwischen die Parsing-Funktionen von `KeycloakAuthUtil`; früher wurde der Header hier selbst zerlegt, und ein Header ohne `"Bearer "` lief in eine `ArrayIndexOutOfBoundsException`, mit der kein Aufrufer gerechnet hatte.

### `CorsFilter.java`

Läuft mit `@PreMatching` und `@Priority(Priorities.AUTHENTICATION - 100)`, also **vor** dem `Authenticator`. Erlaubt sind:

* Requests **ohne** `Origin` (same-origin, klassische Server-zu-Server-Aufrufe),
* exakt gleiche Origin wie die Basis-URI (Schema, Host, Port — mit korrekter Default-Port-Behandlung 80/443),
* `localhost`, `127.0.0.1`, `::1` in jeder Form — für `npm start` gegen einen echten Server.

Alles andere wird mit `403` und `Vary: Origin` abgewiesen. Einen Wildcard-Origin gibt es nicht, und `Access-Control-Allow-Credentials: true` wird nur zusammen mit einem konkret zurückgespiegelten Origin gesetzt (die Kombination `*` + `credentials` wäre ohnehin ungültig).

Für Keycloak selbst ist dieser Filter nicht zuständig — die Requests an den Keycloak (Token-Endpunkt, JWKS) gehen an dessen Host, und dort müssen die Web-Origins im Client konfiguriert sein.

## 2.6 Das Fachbackend (Seschat_Api)

Liegt **nicht** in diesem Repository. Es bekommt dasselbe Access-Token als `Bearer` und prüft es unabhängig. Aus Sicht des Clients:

* Adresse aus der Server-Property `backend-root` (System-Property `seschat.backend.root`, **ohne Fallback** — die gehört in die Serverkonfiguration, nicht in den Code).
* Alle Pfade ebenfalls aus Server-Properties (`buchhaltung.buchung.path`, `admin.benutzer.path`, …). Im Frontend steht kein einziger Backend-Pfad.
* Die Berechtigungsantwort `/user/berechtigung` ist die Quelle der Rollen. Dass das Fachbackend auch **jede Schreiboperation** gegen dieselben Rollen prüft, ist die Annahme, auf der die ganze Frontend-Logik als bloße Bequemlichkeit ruht.

---

# Teil 3 – Die zwei Berechtigungsprüfungen nach dem Rücksprung

Das ist der Punkt, der in der Frage steckt: Keycloak leitet zurück — und dann?

## Prüfung 1: „Darf dieser Mensch Seschat benutzen?“ (`reactAuth.status`)

* **Datenquelle:** der `reactAuth`-Claim *im Token selbst*. Kein zusätzlicher Request.
* **Wer prüft:** `KeycloakAuth` in der Library, direkt nach `init()`.
* **Wann:** noch bevor `ApiProvider` oder `App` existieren.
* **Ergebnis bei Nichtbestehen:** Sperrseite. Der React-Baum unterhalb wird nicht gerendert, es fliegt kein einziger Fachrequest raus.
* **Wer pflegt das:** Keycloak bzw. die zentrale Benutzerverwaltung, nicht Seschat.
* **Serverseitiges Gegenstück:** `withClaim("reactAuth", … status == 0)` im `Authenticator`. Deshalb ist das keine reine UI-Entscheidung — ein manipuliertes Frontend bekäme trotzdem 401 auf alles.

Dass derselbe Claim auf beiden Seiten geprüft wird, ist der eigentliche Grund, warum diese Stufe hält: Das Token ist signiert, der Claim steht drin, und der Server prüft die Signatur. Am Claim lässt sich nichts drehen, ohne die Signatur zu brechen.

## Prüfung 2: „Welche Bereiche darf er sehen?“ (Fachrollen)

* **Datenquelle:** `GET <backend-root>/user/berechtigung` mit dem Token.
* **Wer prüft:** `ProtectedPage` in `App.tsx`, mit den reinen Funktionen aus `rbac.ts`.
* **Wann:** parallel zum ersten Rendern; bis die Antwort da ist, zeigt jede geschützte Route einen Spinner.
* **Ergebnis bei Nichtbestehen:** Umleitung in den ersten erlaubten Bereich plus Hinweisstreifen — oder, wenn es *keinen* erlaubten Bereich gibt, das Sperrpanel.
* **Wer pflegt das:** die Seschat-Benutzerverwaltung (Adminbereich), gespeichert im Fachbackend.
* **Serverseitiges Gegenstück:** Seschat_Api prüft die Rolle bei jedem fachlichen Aufruf selbst.

## Warum zwei Prüfungen und nicht eine?

Sie beantworten verschiedene Fragen und werden an verschiedenen Orten gepflegt. Die Anwendungszulassung ist eine zentrale 11880-Entscheidung („dieser Mitarbeiter darf interne Anwendungen bzw. diese Anwendung benutzen“) und gehört ins Token. Die Fachrolle ist eine Seschat-Entscheidung, sie ändert sich häufiger und hängt an Firmierungen und Fachbereichen — dafür müsste man sonst bei jeder Rollenänderung das Keycloak-Mapping anfassen und der Nutzer müsste sich neu anmelden, damit es greift.

## Was passiert, wenn der Berechtigungsabruf scheitert?

Das ist die Frage, die über Sicherheit entscheidet, und die Antwort ist konsequent:

| Fall | Verhalten |
|---|---|
| Request scheitert (Netz, 500) | `error` gesetzt → `AuthorizationErrorPanel`, alle Bereiche gesperrt |
| 401 | dasselbe Panel, Meldung „Ihre Sitzung ist abgelaufen …“ |
| Antwort leer | „Berechtigungsantwort ist leer.“ → Panel |
| Antwort kein JSON | „Berechtigungsantwort konnte nicht gelesen werden.“ → Panel |
| `errorcode_http` ≠ 200 oder `errorcode_intern` ≠ OK | Fehler aus `errormessage` → Panel |
| `rollen` fehlt oder ist keine Liste | „… rollen fehlt oder ist keine Liste.“ → Panel |
| `rollen` leer | „Der Benutzer hat keine gültige Rolle.“ → Panel |
| unbekannte Rolle | „Unbekannte Rolle: X“ → Panel |
| verbotene Kombination | z. B. „BUCHHALTUNG und ANWENDER sind nicht kombinierbar.“ → Panel |
| Abruf läuft noch | Spinner, **keine** Inhalte |

**Es gibt keinen Zweig, in dem ein Fehler zu offenem Zugang führt.** Jeder Fehlerpfad endet im selben Panel mit „Erneut laden“, und `getAllowedAreas(undefined)` ist `[]`.

---

# Teil 4 – Wo genau ein Unberechtigter hängen bleibt

Durchgespielt für die Fälle, die man realistisch erwartet.

### „Ich rufe direkt `/Seschat/admin` auf, ohne Admin-Rolle.“

Keycloak-Login läuft normal (der Nutzer ist ja ein gültiger Mitarbeiter), `reactAuth.status` ist 0, die App startet. Dann greift `ProtectedPage` für `area="admin"`: `hasAreaAccess(auth, 'admin')` ist falsch → `AccessDeniedRedirect` → `<Navigate to="/anwender" replace state={{accessDenied:true}}>`. Der Nutzer sieht den gelben Streifen und seinen eigenen Bereich. Im Serverlog steht `[app] bereich gesperrt area=admin ziel=/anwender`.

`AdminLayout` wird per `lazy()` geladen — bei gesperrtem Bereich wird das Chunk nicht einmal angefordert.

### „Ich setze im DevTools-React-State `rollen` auf `['ADMIN']`.“

Das Menü zeigt den Adminbereich, die Route lässt einen durch, die Seite rendert. Und dann ruft jeder Hook dort `getAuthorization()` und schickt einen Request an Seschat_Api — mit dem **echten, unveränderten** Token. Das Backend prüft die Rolle selbst und antwortet 403. Ergebnis: leere Tabellen und die Meldung „Sie haben keine Berechtigung für diese Aktion.“ aus `getUserFacingErrorMessage`. Keine Daten.

### „Ich baue mir ein Token.“

Scheitert an der RSA-Signaturprüfung im `Authenticator` und ebenso im Fachbackend. Der Algorithmus ist festverdrahtet RS256, der öffentliche Schlüssel kommt über JWKS aus dem Realm, und der Header des Tokens bestimmt nur die `kid`, nicht das Verfahren.

### „Ich nehme mein Token aus einer anderen 11880-Anwendung.“

Scheitert an `withClaim("azp", …)`: Die ausstellende Client-ID muss in `seschat.authorized_clients` stehen. Genau dafür ist die Prüfung da.

### „Ich fange den `code` aus der Redirect-URL ab.“

* Der Code steht im **Fragment**, erreicht also keinen Server und kein Zugriffslog.
* Er wird Sekundenbruchteile später gegen ein Token getauscht und ist danach verbraucht.
* Ohne den `code_verifier` aus dem localStorage der auslösenden Browsersitzung lässt er sich nicht einlösen (PKCE).
* `history.replaceState` entfernt ihn sofort aus der Adresszeile.

### „Ich schiebe dem Nutzer einen fremden Callback unter.“

`parseCallback` sucht den mitgelieferten `state` im localStorage. Ein fremder Callback hat dort keinen Eintrag → `valid` bleibt `false` → die App behandelt es wie „nicht angemeldet“ und startet den regulären Login.

### „Ich benutze das Token nach dem Abmelden weiter.“

Das Access-Token bleibt bis `exp` technisch gültig — das ist bei JWT so und der Grund, warum die Lebensdauer im Realm kurz gehalten gehört. Das Refresh-Token ist nach dem Logout tot, eine Verlängerung gibt es also nicht. Die maximale Nachwirkung ist die Restlaufzeit des Access-Tokens.

### „Der Nutzer wird während der Sitzung gesperrt.“

Beim nächsten `updateToken` liefert Keycloak ein neues Token mit `reactAuth.status = 1` (oder verweigert den Refresh). `getAuthorization` ruft dann `setTokenParsed`, `KeycloakAuth` rendert neu — und weil der Status nicht mehr 0 ist, erscheint die Sperrseite statt der App. Ohne Reload. Wird die Sitzung ganz beendet, scheitert der Refresh und `getAuthorization` löst einen Login-Redirect aus.

Zu beachten: Wegen `checkLoginIframe: false` merkt die App das **nicht sofort**, sondern erst beim nächsten Request, der ein frisches Token braucht. Bei einer offenen, aber ungenutzten Seite kann das eine Weile dauern.

### „Ich rufe `/Seschat/api/all-properties` direkt auf.“

Ohne gültigen Bearer: 401 aus dem `Authenticator`. Mit gültigem Bearer: die Properties — das sind Backend-Adresse, Pfade und Zeitwerte. Das ist so gewollt; sie enthalten keine Geheimnisse, und der Client braucht sie vor dem ersten Fachrequest.

`GET /Seschat/api/kc-config` ist bewusst offen. Preisgegeben werden Keycloak-URL, Realm und Client-ID — öffentliche Werte eines Public Clients.

---

# Teil 5 – Konfiguration und lokale Entwicklung

## System-Properties auf dem WildFly

| Property | Pflicht | Bedeutung |
|---|---|---|
| `auth.keycloak.root` (oder `…root.seschat`) | ja | Basis-URL des Keycloak |
| `auth.keycloak.realm` (oder `…realm.seschat`) | ja | Realm-Name |
| `auth.keycloak.client_id.seschat` | ja | Client-ID für das Frontend |
| `seschat.authorized_clients` | ja | `;`-getrennte Liste erlaubter `azp`-Werte |
| `seschat.backend.root` | ja | Adresse von Seschat_Api (`backend-root`, kein Fallback) |

Die `.seschat`-Varianten gehen vor. Fehlt eine Pflicht-Property, liefert `kc-config` eine 500 und die App zeigt „Keycloak-Konfiguration konnte nicht geladen werden.“ — der häufigste Grund, wenn ein frisch aufgesetzter Server gar nicht erst startet.

## Was im Keycloak-Client stehen muss

* **Public Client**, Standard Flow aktiv, kein Secret.
* **Valid Redirect URIs**: alle Pfade unterhalb von `/Seschat/*` auf dem jeweiligen Host — die `redirect_uri` ist die aufgerufene Seite, nicht ein fester Startpfad. Für die lokale Entwicklung zusätzlich der Parcel-Dev-Server.
* **Web Origins**: die Origins, von denen aus der Token-Endpunkt per XHR angesprochen wird.
* **Protocol Mapper** für `reactAuth`, `employeeNumber`, `given_name`, `family_name`, `preferred_username`.

Ohne den `reactAuth`-Mapper landet man bei `status: -1` und „Ein unbekannter Fehler ist aufgetreten“ — und serverseitig bei 401. Das ist der zweithäufigste Startfehler.

## Lokal (`npm start`)

`Client/.env` steuert die Quelle der Keycloak-Konfiguration:

```
DEV_KEYCLOAK_CONFIG_SOURCE=backend   # Standard: /Seschat/api/kc-config
DEV_KEYCLOAK_CONFIG_SOURCE=env       # aus .env: KEYCLOAK_URL / _REALM / _CLIENT_ID
```

Der `env`-Weg existiert für den Fall, dass kein WildFly läuft. Er greift nur bei `NODE_ENV !== 'production'`; in der gebauten WAR ist der Zweig unerreichbar. Fehlt einer der drei Werte, kommt „Lokale Keycloak-Konfiguration unvollstaendig: … fehlt in der .env-Datei.“

Damit der Dev-Server gegen ein echtes Backend arbeiten kann, lässt der `CorsFilter` Loopback-Origins zu.

## In Tests

`Client/src/web/test/mocks/commonComponents.ts`:

```ts
export const useKeycloak = () => ({
  getAuthorization: async () => 'Bearer test-token',
  tokenParsed: {},
})
```

Die ganze Keycloak-Schicht wird durch diese vier Zeilen ersetzt. Deshalb ist es wichtig, dass die Berechtigungslogik in `rbac.ts` als **reine Funktionen ohne React** liegt — `rbac.test.ts` prüft sie direkt, ohne irgendeinen Auth-Aufbau.

---

# Teil 6 – Stolperfallen und bewusste Entscheidungen

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

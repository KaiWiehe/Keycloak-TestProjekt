/**
 * ============================================================================
 *  WAY B — THE SAME LOGIN, BUT WITH keycloak-js
 * ============================================================================
 *
 *  Gleiches Ziel wie `manual.js`, gleiche Reihenfolge, nur macht die Bibliothek
 *  die Arbeit. Lies die beiden Dateien nacheinander — der Unterschied ist der
 *  eigentliche Lehrstoff.
 *
 *  DIE LANDKARTE:
 *
 *    Seite wird geladen
 *         |
 *         +-> §2  keycloak.init()  <-- EIN Aufruf, der zwei Dinge tut:
 *              |                       a) steht ein code in der URL? -> einlösen
 *              |                       b) sonst: nichts, `authenticated` = false
 *              |
 *              +-- nicht angemeldet -> auf den Knopf warten
 *              |        |
 *              |        [Knopf gedrückt] -> keycloak.login()
 *              |                               |
 *              |                          [Keycloak zeigt Login,
 *              |                           leitet zurück mit #code=...]
 *              |                               |
 *              |        Seite wird neu geladen, §2 von vorn -------+
 *              |                                                   |
 *              +-- angemeldet <--------------------------------------+
 *                     |
 *                     +-> §5 reactAuth.status prüfen
 *
 *  WAS `init()` UND `login()` FÜR UNS ERLEDIGEN — und was in `manual.js` jeweils
 *  von Hand dasteht:
 *
 *    state und nonce würfeln ............. createLoginUrl()     | manual §2
 *    code_verifier + code_challenge ...... createLoginUrl()     | manual §2
 *    Zwischenlager für beides ............ localStorage         | manual §2
 *    Anmelde-URL bauen ................... createLoginUrl()     | manual §2
 *    Callback in der URL erkennen ........ parseCallbackUrl()   | manual §3
 *    URL putzen (replaceState) ........... processInit()        | manual §3
 *    state vergleichen ................... parseCallback()      | manual §3
 *    Code gegen Tokens tauschen .......... processCallback()    | manual §3
 *    nonce vergleichen ................... authSuccess()        | manual §3
 *    JWT dekodieren ...................... setToken()           | manual §1
 *    Uhrzeit-Abweichung ausgleichen ...... setToken()           | (gar nicht)
 *    Token erneuern ...................... updateToken()        | manual §4
 *    Logout-URL bauen .................... createLogoutUrl()    | manual §5
 *
 *  DER PREIS: Von all dem sieht man nichts. Die Bibliothek bietet nur
 *  `onAuthSuccess`, `onAuthError` und ein paar Geschwister an — und die sagen
 *  nur DASS etwas passiert ist. Drei Beispiele, alle im Quelltext von
 *  keycloak-js 24.0.2 nachgesehen:
 *
 *   1. Passt der `state` nicht, meldet die Bibliothek das NIRGENDS.
 *      `processInit()` prüft `callback.valid` und fällt sonst stillschweigend
 *      in den normalen Anmeldeweg zurück. Kein Fehler, kein `onAuthError` —
 *      man sieht nur, dass wieder angemeldet wird. `manual.js` sagt an
 *      derselben Stelle klar, dass der state nicht passte.
 *
 *   2. Scheitert der Token-Tausch, wird `onAuthError()` OHNE Argument gerufen.
 *      Man erfährt dass, nie warum. Den Grund zeigt nur der Netzwerk-Tab.
 *
 *   3. Der POST an den Token-Endpunkt läuft mit `withCredentials = true`.
 *      Folge: Steht im Keycloak-Client Web Origins auf `*`, lehnt der Browser
 *      die Antwort ab und NUR dieser Weg scheitert — `manual.js` läuft weiter.
 *      Ein Fehlerbild, das einen ohne dieses Wissen lange beschäftigt.
 *
 *  UND EIN VORTEIL, der oft übersehen wird: keycloak-js rechnet SHA-256 mit
 *  einer mitgelieferten JS-Implementierung (js-sha256), nicht mit
 *  `crypto.subtle`. Deshalb läuft dieser Weg auch außerhalb eines Secure
 *  Context — `manual.js` steigt dort aus.
 */

// ============================================================================
//  §0  CONFIGURATION AND OUTPUT
// ============================================================================

/** Siehe manual.js §0 — dynamisch, damit eine fehlende config.js auffällt. */
const config = await import('../config.js')
  .then(module => module.KEYCLOAK_CONFIG)
  .catch(() => null)

const outputElement = document.getElementById('output')

const log = (message, data) => {
  const line = data === undefined ? message : `${message}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
  console.log(`[library] ${line}`)
  outputElement.textContent += `${line}\n\n`
}

const logError = message => log(`ERROR: ${message}`)

/**
 * Wohin Keycloak zurückleiten soll. Ohne diese Angabe nimmt keycloak-js
 * `location.href` — also samt Query und Fragment. Hier wird es ausdrücklich auf
 * die nackte Seitenadresse gesetzt, damit im Keycloak-Client genau eine
 * Redirect-URI steht und sie mit der von `manual.js` vergleichbar ist.
 */
const REDIRECT_URI = `${window.location.origin}${window.location.pathname}`

// ============================================================================
//  §1  THE INSTANCE AND ITS CALLBACKS
// ============================================================================

/**
 * `window.Keycloak` kommt aus `vendor/keycloak.js`, das die HTML-Seite als
 * klassisches Script vorher lädt.
 *
 * Wichtig: Es muss `keycloak.js` sein, NICHT `keycloak.mjs`. Die .mjs-Variante
 * importiert `js-sha256` und `jwt-decode` über bloße Paketnamen, die ein
 * Browser ohne Bundler nicht auflösen kann. `keycloak.js` ist das UMD-Bundle
 * mit beidem eingebaut.
 */
const keycloak = config ? new window.Keycloak(config) : null

/**
 * Alle Rückmeldungen MÜSSEN vor `init()` gesetzt werden — `init()` feuert
 * `onAuthSuccess` ja bereits selbst, wenn es einen Callback verarbeitet.
 *
 * Das hier ist die vollständige Liste dessen, was keycloak-js nach außen
 * meldet. Mehr gibt es nicht.
 */
const registerCallbacks = () => {
  keycloak.onAuthSuccess = () => log('onAuthSuccess — signed in. The token exchange happened inside the library.')

  // Ohne Argument beim gescheiterten Token-Tausch (siehe Kopf, Punkt 2). Nur
  // wenn Keycloak schon im Fragment einen Fehler zurückgibt, kommen `error`
  // und `error_description` mit.
  keycloak.onAuthError = data =>
    logError(data ? `onAuthError: ${JSON.stringify(data)}` : 'onAuthError — with no reason given. Only the network tab shows the real cause.')

  keycloak.onAuthRefreshSuccess = () => log('onAuthRefreshSuccess — received a new access token.')
  keycloak.onAuthRefreshError = () => logError('onAuthRefreshError — the refresh failed.')

  // Feuert aus `clearToken()` heraus, nicht beim Logout-Redirect — da ist die
  // Seite längst weg. In der Praxis sieht man diese Zeile fast nie.
  keycloak.onAuthLogout = () => log('onAuthLogout — the library discarded the tokens.')

  // Muss gesetzt sein, sonst schweigt keycloak-js an dieser Stelle auch mit
  // `enableLogging: true`.
  keycloak.onTokenExpired = () => log('onTokenExpired — the access token just expired.')
}

// ============================================================================
//  §2  init() — outbound and inbound in a single call
// ============================================================================

/**
 * `init()` ist beides zugleich:
 *
 *  - Steht ein `code` in der URL, löst es ihn ein (state prüfen, POST an den
 *    Token-Endpunkt, nonce prüfen, dekodieren) und liefert `true`.
 *  - Sonst passiert nichts und es liefert `false`.
 *
 * `onLoad` wird hier ABSICHTLICH weggelassen. Mit `onLoad: 'login-required'` —
 * so macht es Seschat — würde `init()` bei fehlender Sitzung sofort selbst
 * weiterleiten, und es gäbe gar keinen Knopf zu drücken. Ohne `onLoad` bleibt
 * der Hinweg da, wo er hier hingehört: in `login()`, ausgelöst per Klick.
 * Genau wie in `manual.js`.
 */
const initialize = async () => {
  log('init() — processes a callback if one is present in the URL')

  const authenticated = await keycloak.init({
    //onLoad: 'login-required', // Direkt weiterleiten, wenn nicht angemeldet. Seschat macht das so, hier Knopf drücken.
    // Keine periodische Iframe-Prüfung gegen den Keycloak. Spart Dauer-Traffic
    // und umgeht die Third-Party-Cookie-Sperren moderner Browser. Der Preis:
    // Wird die Sitzung woanders beendet, fällt das erst beim nächsten
    // fehlschlagenden Erneuern auf. Seschat stellt es genauso ein.
    checkLoginIframe: false,
    // Schreibt die internen Schritte der Bibliothek in die Browserkonsole.
    // Lohnt sich zum Mitlesen — es sind allerdings nur eine Handvoll Zeilen,
    // und über Redirect, Callback-Erkennung und Token-Tausch steht nichts
    // darin.
    enableLogging: true,
    redirectUri: REDIRECT_URI,
  })

  log(`init() finished — authenticated: ${authenticated}`)
  return authenticated
}

// ============================================================================
//  §3  REFRESHING THE TOKEN
// ============================================================================

/**
 * `updateToken(minValidity)` erneuert nur, wenn das Token in weniger als
 * `minValidity` Sekunden abläuft, und liefert zurück, OB es das getan hat.
 *
 * Genau dieser Aufruf steht in Seschat vor jedem Backend-Request:
 *
 *     const authChanged = await instance.updateToken(5)
 *     return 'Bearer ' + instance.token
 *
 * Meistens liefert er `false` und tut nichts — das ist der Normalfall und der
 * Grund, warum man ihn bedenkenlos vor jeden Request setzen kann.
 *
 * `-1` erzwingt die Erneuerung, egal wie lange das Token noch läuft. Das ist
 * hier nur zum Vorführen da, damit man den Effekt überhaupt sieht.
 */
const refreshTokens = async force => {
  const expBefore = keycloak.tokenParsed.exp
  const refreshed = await keycloak.updateToken(force ? -1 : 5)

  log(refreshed ? 'updateToken: refreshed' : 'updateToken: did nothing — the token was still valid long enough', {
    call: force ? 'updateToken(-1)' : 'updateToken(5)',
    returnValue: refreshed,
    expBefore,
    expAfter: keycloak.tokenParsed.exp,
  })
}

// ============================================================================
//  §4  LOGGING OUT
// ============================================================================

/**
 * `logout()` baut die Logout-URL und leitet dorthin. Sie enthält `client_id`,
 * `post_logout_redirect_uri` und — sofern ein id_token da ist — `id_token_hint`.
 * Dieselben Parameter also, die `manual.js §5` von Hand zusammensetzt, und mit
 * derselben Voraussetzung: Die Zieladresse muss im Client unter "Valid post
 * logout redirect URIs" stehen.
 *
 * Und dieselbe Tragweite: Das beendet die Sitzung beim Keycloak, nicht nur auf
 * dieser Seite.
 */
const logout = () => {
  log('logout() — the library builds the logout URL and redirects')
  keycloak.logout({ redirectUri: `${window.location.origin}/index.html` })
}

// ============================================================================
//  §5  THE AUTHORIZATION CHECK AFTER THE CALLBACK
// ============================================================================

/**
 * Wortgleich zu `manual.js §6` — und das ist die Pointe: Diese Prüfung hängt am
 * TOKEN, nicht am Anmeldeweg. Ob die Bibliothek das Token geholt hat oder
 * eigener Code, ändert daran nichts.
 *
 * keycloak-js kennt `reactAuth` nicht; das ist ein hauseigener Claim. Die
 * Bibliothek kann diese Frage also gar nicht beantworten — sie liefert nur das
 * dekodierte Token unter `keycloak.tokenParsed`.
 *
 *       0  zugelassen
 *       1  nicht für DIESE Anwendung zugelassen
 *       2  gar nicht für interne Anwendungen zugelassen
 *      -1  Claim fehlt oder ist unbrauchbar  ->  gilt als GESPERRT, nicht offen
 *
 * Auch hier: Das ist Bequemlichkeit, keine Absicherung. Der Server prüft
 * denselben Claim noch einmal am signierten Token.
 *
 * HIER ENDET DIESES PROJEKT. Die zweite, fachliche Berechtigungsprüfung
 * (Rollen aus einem Backend) ist absichtlich nicht eingebaut.
 */
const checkReactAuth = () => {
  const source = keycloak.tokenParsed?.reactAuth ? 'access_token' : keycloak.idTokenParsed?.reactAuth ? 'id_token' : null
  const reactAuth = source === 'access_token' ? keycloak.tokenParsed.reactAuth : source === 'id_token' ? keycloak.idTokenParsed.reactAuth : null

  const status = Number.isInteger(Number(reactAuth?.status)) ? Number(reactAuth.status) : -1
  const meanings = {
    0: 'allowed',
    1: 'not allowed for this application',
    2: 'not allowed for internal applications at all',
  }

  log('Checked reactAuth', {
    foundIn: source ?? 'nowhere — is the protocol mapper missing in the realm?',
    status,
    meaning: meanings[status] ?? 'unknown, treated as denied',
    access: status === 0 ? 'GRANTED' : 'DENIED',
  })

  return status === 0
}

// ============================================================================
//  §6  ENTRY POINT — what happens when the page loads
// ============================================================================

const loginButton = document.getElementById('login')
const refreshButton = document.getElementById('refresh')
const checkButton = document.getElementById('check')
const logoutButton = document.getElementById('logout')

const updateButtons = loggedIn => {
  loginButton.hidden = loggedIn
  refreshButton.hidden = !loggedIn
  checkButton.hidden = !loggedIn
  logoutButton.hidden = !loggedIn
}

const start = async () => {
  if (!config) {
    logError('config.js is missing. Copy config.example.js to config.js and fill in the three values.')
    loginButton.disabled = true
    return
  }
  if (typeof window.Keycloak !== 'function') {
    logError('vendor/keycloak.js was not loaded — window.Keycloak is missing.')
    loginButton.disabled = true
    return
  }

  registerCallbacks()

  // `login()` baut die Anmelde-URL (mit state, nonce und PKCE) und leitet
  // weiter. Was dabei entsteht, landet unter `kc-callback-<state>` im
  // localStorage — da kann man beim Klicken in den DevTools zusehen.
  loginButton.addEventListener('click', () => {
    log('login() — redirecting to Keycloak')
    keycloak.login({ redirectUri: REDIRECT_URI })
  })

  refreshButton.addEventListener('click', () => {
    refreshTokens(true).catch(error => {
      updateButtons(false)
      logError(`Refresh failed (${error?.message ?? error}) — please sign in again.`)
    })
  })

  checkButton.addEventListener('click', () => {
    refreshTokens(false).catch(error => {
      updateButtons(false)
      logError(`updateToken(5) failed (${error?.message ?? error}) — please sign in again.`)
    })
  })

  logoutButton.addEventListener('click', logout)

  // Vor init() nachsehen, ob ein Callback in der URL steht — danach hat die
  // Bibliothek ihn schon weggeputzt und man sieht nicht mehr, dass er da war.
  const fragment = window.location.hash.replace(/^#/, '')
  if (fragment) log('Something is in the URL fragment — probably the callback', `#${fragment}`)

  let authenticated
  try {
    authenticated = await initialize()
  } catch (error) {
    logError(`init() failed: ${error?.message ?? JSON.stringify(error)}`)
    updateButtons(false)
    return
  }

  if (!authenticated) {
    log('Ready. Press the button to start the login.')
    updateButtons(false)
    return
  }

  log('Access token claims (keycloak.tokenParsed)', keycloak.tokenParsed)
  const granted = checkReactAuth()
  updateButtons(true)
  if (!granted) log('At this point a real application would show a denial page instead of its content.')
}

await start()

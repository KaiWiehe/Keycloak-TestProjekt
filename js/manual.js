/**
 * ============================================================================
 *  WAY A — SIGNING IN WITH KEYCLOAK, BY HAND
 * ============================================================================
 *
 *  Authorization Code Flow mit PKCE, ohne Bibliothek. Nur `fetch`, `crypto`
 *  und `sessionStorage`.
 *
 *  DIE LANDKARTE — so läuft es ab:
 *
 *    Seite wird geladen
 *         |
 *         +-- steht ein "code" im Fragment der URL?
 *              |
 *              NEIN -> nichts tun, auf den Knopf warten
 *              |        |
 *              |        [Knopf gedrückt]   -> §2 startLogin()
 *              |                                - state + nonce würfeln
 *              |                                - code_verifier würfeln
 *              |                                - code_challenge = SHA256(verifier)
 *              |                                - alles in sessionStorage
 *              |                                - location.assign(Keycloak)
 *              |                                      |
 *              |                                 [Keycloak zeigt Login,
 *              |                                  leitet zurück auf
 *              |                                  diese Seite mit #code=...]
 *              |                                      |
 *              JA <------------------------------------+
 *              |
 *              +-> §3 handleCallback()
 *                     - URL putzen (code raus aus der Adresszeile)
 *                     - state vergleichen
 *                     - POST /token: code + code_verifier -> Tokens
 *                     - nonce im id_token vergleichen
 *                     - JWT dekodieren
 *                     - §6 reactAuth.status prüfen
 *
 *  WAS DIESE DATEI BEWUSST NICHT TUT:
 *
 *  - Die Signatur des Tokens prüfen. Das ist Aufgabe des Servers, der das
 *    Token entgegennimmt (er holt sich den öffentlichen Schlüssel unter
 *    <realm>/protocol/openid-connect/certs). Ein Browser, der sein eigenes
 *    Token für gültig erklärt, beweist gar nichts — er könnte die Prüfung
 *    genauso gut weglassen. Hier wird nur DEKODIERT, um hineinzusehen.
 *
 *  - Fachliche Berechtigungen laden. Der Umfang endet bei `reactAuth.status`
 *    („darf dieser Mensch die Anwendung überhaupt benutzen?"). Welche Bereiche
 *    jemand sehen darf, käme aus einem Backend — siehe §6.
 */

// ============================================================================
//  §0  CONFIGURATION, ENDPOINTS, STATE
// ============================================================================

/**
 * Dynamischer Import statt `import ... from '../config.js'` oben.
 *
 * Grund: Fehlt die Datei, würde ein statischer Import das gesamte Modul nicht
 * laden — die Seite bliebe stumm, ohne jeden Hinweis. So gibt es stattdessen
 * eine Meldung, die sagt, was zu tun ist.
 */
const config = await import('../config.js')
  .then(module => module.KEYCLOAK_CONFIG)
  .catch(() => null)

/**
 * Die vier OIDC-Adressen eines Realms. Keycloak veröffentlicht sie auch unter
 * `/.well-known/openid-configuration`; wer sie — wie hier — selbst zusammenbaut,
 * spart einen Request. keycloak-js macht es genauso.
 *
 * Der abschließende Schrägstrich wird abgeschnitten, damit `https://kc/` und
 * `https://kc` dieselbe Adresse ergeben.
 */
const REALM_URL = config && `${config.url.replace(/\/+$/, '')}/realms/${encodeURIComponent(config.realm)}`
const ENDPOINT = {
  authorize: `${REALM_URL}/protocol/openid-connect/auth`,
  token: `${REALM_URL}/protocol/openid-connect/token`,
  logout: `${REALM_URL}/protocol/openid-connect/logout`,
}

/**
 * Wohin Keycloak zurückleiten soll: diese Seite, ohne Query und ohne Fragment.
 *
 * Genau dieser Wert muss im Keycloak-Client unter "Valid Redirect URIs" stehen —
 * zeichengenau. Deshalb hat der Server dieses Projekts auch einen festen Port.
 */
const REDIRECT_URI = `${window.location.origin}${window.location.pathname}`

/** Schlüssel, unter dem der laufende Anmeldeversuch zwischengelagert wird. */
const STORAGE_KEY = 'manual.loginAttempt'

/**
 * Die Tokens leben NUR hier, in einer Variablen.
 *
 * Kein localStorage, kein Cookie — genauso hält es keycloak-js, und genauso
 * hält es Seschat. Die Folge sieht man sofort: Ein Reload wirft die Tokens weg
 * und man fängt von vorn an. Das ist kein Fehler, sondern der Preis dafür, dass
 * kein Token auf der Platte liegen bleibt.
 */
let session = null

// ----------------------------------------------------------------------------
//  Output: eine Zeile pro Schritt, in die Konsole und auf die Seite.
//  Absichtlich primitiv — der Ablauf soll im Vordergrund stehen, nicht das UI.
// ----------------------------------------------------------------------------

const outputElement = document.getElementById('output')

const log = (message, data) => {
  const line = data === undefined ? message : `${message}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
  console.log(`[manual] ${line}`)
  outputElement.textContent += `${line}\n\n`
}

const logError = message => log(`ERROR: ${message}`)

// ============================================================================
//  §1  TOOLING
// ============================================================================

/**
 * Zufall aus `crypto.getRandomValues`, nicht aus `Math.random`.
 *
 * Das ist hier keine Feinheit: `state` und `code_verifier` sind genau das, was
 * einen echten Rückweg von einem untergeschobenen unterscheidet. Wären sie
 * erratbar, wäre der ganze Aufwand umsonst.
 *
 * Das Alphabet hat 64 Zeichen, und 256 ist ohne Rest durch 64 teilbar — deshalb
 * verzerrt `byte & 63` die Verteilung nicht. (keycloak-js nimmt 62 Zeichen und
 * hat damit eine winzige Schieflage. Bei 96 Zeichen Länge ist das ohne
 * Bedeutung, aber es zeigt, worauf man bei so etwas achtet.)
 */
const randomString = length => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, byte => alphabet[byte & 63]).join('')
}

/** base64url = base64 ohne `+`, `/` und Polsterung. So verlangt es RFC 7636. */
const base64Url = bytes =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/**
 * Die PKCE-Challenge: SHA-256 über den Verifier, base64url kodiert.
 *
 * Der Sinn von PKCE in einem Satz: Der Browser schickt beim Hinweg nur den HASH
 * mit und beim Einlösen des Codes das ORIGINAL. Wer den Code unterwegs
 * abfängt, kann ihn ohne das Original nicht benutzen.
 *
 * `crypto.subtle` gibt es nur im Secure Context — also unter https, unter
 * http://localhost oder http://127.0.0.1, sonst nicht. keycloak-js umgeht das,
 * indem es SHA-256 mit einer mitgelieferten JS-Implementierung rechnet
 * (js-sha256); deshalb läuft Weg B auch dort, wo Weg A aussteigt.
 */
const createCodeChallenge = async verifier => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

/**
 * Die Nutzlast eines JWT lesen. Ein JWT besteht aus drei Teilen, durch Punkte
 * getrennt: Header, Nutzlast, Signatur. Uns interessiert der mittlere.
 *
 * ACHTUNG, die klassische Falle: `JSON.parse(atob(part))` reicht NICHT.
 * `atob` liefert Bytes als Zeichen zurück, und sobald ein Name einen Umlaut
 * enthält, steht da "MÃ¼ller" statt "Müller". Der Umweg über `Uint8Array` und
 * `TextDecoder` setzt die UTF-8-Bytes richtig zusammen.
 *
 * Und nochmal, weil es der häufigste Denkfehler ist: Dekodieren ist KEINE
 * Prüfung. Jeder kann ein JWT dekodieren — es ist nur base64, keine
 * Verschlüsselung. Was ein Token echt macht, ist die Signatur, und die prüft
 * der Server.
 */
const decodeJwtPayload = token => {
  const parts = String(token).split('.')
  if (parts.length !== 3) throw new Error('Not a JWT: it does not have three dot-separated parts.')

  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

// ============================================================================
//  §2  OUTBOUND — starting the login
// ============================================================================

/**
 * Würfelt die Geheimnisse, legt sie beiseite und verlässt die Seite.
 *
 * Danach hat dieser Code keine Kontrolle mehr: Der Browser ist beim Keycloak,
 * der Nutzer tippt sein Passwort, und erst der Rücksprung (§3) bringt uns
 * zurück. Alles, was den Rücksprung überleben muss, muss VORHER gespeichert
 * sein — deshalb der `sessionStorage` weiter unten.
 */
const startLogin = async () => {
  // Gegen CSRF: Der Wert geht mit zum Keycloak und kommt unverändert zurück.
  // Beim Rücksprung vergleichen wir (§3). Ein Callback, den jemand anders uns
  // unterschiebt, kennt diesen Wert nicht.
  const state = randomString(32)

  // Gegen Replay: Keycloak legt diesen Wert ins id_token. Ein altes, wieder
  // eingespieltes Token trägt eine andere nonce und fliegt auf.
  const nonce = randomString(32)

  // PKCE. 96 Zeichen — erlaubt sind 43 bis 128 (RFC 7636).
  const codeVerifier = randomString(96)
  const codeChallenge = await createCodeChallenge(codeVerifier)

  log('1. Generated secrets', { state, nonce, codeVerifier, codeChallenge })

  /**
   * sessionStorage, nicht localStorage — mit Absicht:
   *
   *  - Der Rücksprung landet im SELBEN Tab, weiter muss es nicht reichen.
   *  - sessionStorage ist pro Tab getrennt. Zwei parallel geöffnete Tabs
   *    überschreiben sich also nicht gegenseitig den Verifier.
   *  - Er räumt sich beim Schließen des Tabs selbst auf. Ein vergessener
   *    code_verifier in localStorage überlebt dagegen Tage.
   *
   * keycloak-js MUSS localStorage nehmen (Schlüssel `kc-callback-<state>`),
   * weil es auch Popup- und Iframe-Varianten bedient, bei denen der Callback in
   * einem anderen Fenster ankommt. Diese Seite braucht das nicht.
   */
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ state, nonce, codeVerifier, redirectUri: REDIRECT_URI }))

  const url = new URL(ENDPOINT.authorize)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('scope', 'openid')
  // `code` = Authorization Code Flow. Die Alternative `token` (Implicit Flow)
  // liefert das Token direkt in der URL und gilt seit Jahren als überholt.
  url.searchParams.set('response_type', 'code')
  // `fragment` = die Antwort kommt hinter dem `#`. Fragmente schickt der Browser
  // NICHT an den Server — der Code taucht damit in keinem Zugriffslog und in
  // keinem Referer auf. Bei `query` stünde er in der Adresszeile vor dem `#`
  // und würde mitgeschickt.
  url.searchParams.set('response_mode', 'fragment')
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  log('2. Redirecting to Keycloak', url.toString())
  window.location.assign(url.toString())
}

// ============================================================================
//  §3  INBOUND — handling the callback
// ============================================================================

/**
 * Steht in der URL ein Rücksprung vom Keycloak?
 *
 * Gelesen wird das Fragment (`#...`), weil wir oben `response_mode=fragment`
 * angefordert haben. Ohne `state` ist es kein Callback von uns.
 */
const readCallbackFromUrl = () => {
  const fragment = window.location.hash.replace(/^#/, '')
  if (!fragment) return null

  const params = new URLSearchParams(fragment)
  if (!params.has('state')) return null
  if (!params.has('code') && !params.has('error')) return null

  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  }
}

/**
 * Ein POST an den Token-Endpunkt. Wird zweimal gebraucht: beim Einlösen des
 * Codes (§3) und beim Erneuern (§4).
 */
const callTokenEndpoint = async fields => {
  let response
  try {
    response = await fetch(ENDPOINT.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      // Bewusst OHNE `credentials: 'include'`. keycloak-js setzt hier
      // `withCredentials = true`, und das verschärft die CORS-Anforderung:
      // Steht im Keycloak-Client Web Origins auf `*`, antwortet der Server mit
      // `Access-Control-Allow-Origin: *`, und genau das lehnt der Browser bei
      // einer Anfrage mit Zugangsdaten ab. Weg B scheitert dann, Weg A nicht.
    })
  } catch (networkError) {
    // `fetch` wirft bei Netzwerk- UND bei CORS-Problemen dasselbe nackte
    // "Failed to fetch" — aus Sicherheitsgründen verrät der Browser nicht,
    // welches von beidem es war.
    throw new Error(
      `Token endpoint unreachable (${networkError.message}). Either ${new URL(ENDPOINT.token).origin} is down, ` +
        'or it is CORS — in that case this origin is missing from "Web Origins" in the Keycloak client. ' +
        'The network tab shows which one it is.'
    )
  }

  const body = await response.text()
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`Token endpoint did not return JSON (HTTP ${response.status}): ${body.slice(0, 300)}`)
  }

  // Keycloak schickt bei Fehlern `error` und `error_description` — das ist die
  // brauchbarste Meldung im ganzen Ablauf. Häufig: `invalid_grant` (Code schon
  // benutzt, abgelaufen, oder die redirect_uri weicht ab).
  if (!response.ok) {
    throw new Error(`${payload.error ?? `HTTP ${response.status}`}: ${payload.error_description ?? body.slice(0, 300)}`)
  }

  return payload
}

/** Die Antwort des Token-Endpunkts in `session` übernehmen. */
const storeTokens = payload => {
  session = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    accessClaims: decodeJwtPayload(payload.access_token),
    idClaims: payload.id_token ? decodeJwtPayload(payload.id_token) : null,
  }
}

const handleCallback = async callback => {
  log('3. Detected callback from Keycloak', `#${window.location.hash.replace(/^#/, '')}`)

  /**
   * ERST PUTZEN, DANN PRÜFEN.
   *
   * `replaceState` ersetzt den aktuellen History-Eintrag, ohne die Seite neu zu
   * laden — der Code verschwindet damit aus der Adresszeile, aus der History
   * und aus allem, was der Nutzer versehentlich kopieren könnte. Das passiert
   * vor jeder weiteren Prüfung, damit selbst ein ungültiger Callback keine
   * Spur hinterlässt. keycloak-js macht es an genau derselben Stelle.
   */
  window.history.replaceState(window.history.state, '', REDIRECT_URI)
  log('4. Cleaned the URL — code and state are gone from the address bar')

  // Keycloak meldet Fehler im selben Fragment, z. B. `access_denied`, wenn der
  // Nutzer die Anmeldung abbricht.
  if (callback.error) {
    throw new Error(`Keycloak reports: ${callback.error} — ${callback.errorDescription ?? 'no further description'}`)
  }

  const stored = sessionStorage.getItem(STORAGE_KEY)
  // Beim Lesen sofort wegwerfen: Ein Callback ist genau EINMAL gültig. Wer die
  // Callback-URL aus der History ein zweites Mal aufruft, findet nichts mehr
  // vor. keycloak-js macht dasselbe.
  sessionStorage.removeItem(STORAGE_KEY)

  if (!stored) {
    throw new Error(
      'No stored login attempt matches this state. The callback is discarded — that is exactly how ' +
        'you fend off a planted callback.'
    )
  }

  const attempt = JSON.parse(stored)
  if (attempt.state !== callback.state) {
    throw new Error(`State mismatch: expected ${attempt.state}, received ${callback.state}. Callback discarded.`)
  }
  log('5. State verified — matches the stored one')

  const payload = await callTokenEndpoint({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: attempt.redirectUri,
    client_id: config.clientId,
    // Der Beweis, dass dieselbe Browsersitzung den Hinweg angestoßen hat.
    // Keycloak rechnet SHA-256 darüber und vergleicht mit der challenge von §2.
    code_verifier: attempt.codeVerifier,
    // Kein client_secret: Das hier ist ein Public Client. Ein Secret wäre im
    // Browser ohnehin nicht geheim zu halten — dafür gibt es PKCE.
  })

  log('6. Exchanged the code for tokens', {
    accessToken: `${payload.access_token?.length ?? 0} characters`,
    refreshToken: `${payload.refresh_token?.length ?? 0} characters`,
    idToken: `${payload.id_token?.length ?? 0} characters`,
    expiresIn: payload.expires_in,
    refreshExpiresIn: payload.refresh_expires_in,
  })

  storeTokens(payload)

  // nonce-Abgleich: Passt sie nicht, gehört das id_token nicht zu dieser
  // Anfrage und alles fliegt weg. keycloak-js tut hier dasselbe und schreibt
  // "Invalid nonce, clearing token" in die Konsole.
  if (session.idClaims) {
    if (session.idClaims.nonce !== attempt.nonce) {
      session = null
      throw new Error('Nonce in the id_token does not match. Tokens discarded.')
    }
    log('7. Nonce in the id_token verified — matches')
  }

  log('8. Tokens decoded — access token claims', session.accessClaims)
}

// ============================================================================
//  §4  REFRESHING THE TOKEN
// ============================================================================

/**
 * Derselbe Endpunkt, andere `grant_type`. Kein Redirect, der Nutzer merkt
 * nichts.
 *
 * In Seschat steht genau das vor JEDEM Backend-Request, versteckt in
 * `getAuthorization()`: erst `updateToken(5)` — erneuere, wenn weniger als
 * 5 Sekunden Restlaufzeit — dann der Request. Deshalb kann dort nie ein
 * abgelaufenes Token rausgehen.
 *
 * Scheitert das Erneuern, ist die Sitzung zu Ende: Das refresh_token ist
 * abgelaufen oder die SSO-Sitzung wurde beendet. Dann hilft nur eine neue
 * Anmeldung.
 */
const refreshTokens = async () => {
  if (!session?.refreshToken) throw new Error('No refresh token available.')

  const expBefore = session.accessClaims.exp
  const payload = await callTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: config.clientId,
  })

  storeTokens(payload)
  log('Token refreshed', { expBefore, expAfter: session.accessClaims.exp, validFor: `${payload.expires_in} s` })
}

// ============================================================================
//  §5  LOGGING OUT
// ============================================================================

/**
 * Wichtig zu verstehen: Abmelden heißt nicht „diese Seite vergisst das Token",
 * sondern „die Sitzung beim Keycloak wird beendet". Danach verlangt auch jede
 * ANDERE Anwendung im selben Realm wieder eine Anmeldung — das ist die Kehrseite
 * von Single Sign-on.
 *
 * Die Parameter haben sich mit Keycloak 18 geändert: Das alte `redirect_uri`
 * am Logout-Endpunkt gibt es nicht mehr. Heute braucht es
 * `post_logout_redirect_uri` PLUS entweder `client_id` oder `id_token_hint`,
 * und die Zieladresse muss im Client unter "Valid post logout redirect URIs"
 * freigegeben sein. Fehlt das, bleibt man auf einer Keycloak-Seite stehen.
 */
const logout = () => {
  const url = new URL(ENDPOINT.logout)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/index.html`)
  if (session?.idToken) url.searchParams.set('id_token_hint', session.idToken)

  log('Logging out — redirecting to the logout endpoint', url.toString())

  session = null
  sessionStorage.removeItem(STORAGE_KEY)
  window.location.assign(url.toString())
}

// ============================================================================
//  §6  THE AUTHORIZATION CHECK AFTER THE CALLBACK
// ============================================================================

/**
 * Keycloak sagt nur: „Das ist wirklich Herr Müller." Ob Herr Müller DIESE
 * Anwendung benutzen darf, ist eine zweite Frage — und die beantwortet hier der
 * hauseigene Claim `reactAuth`, den Keycloak beim Ausstellen ins Token legt:
 *
 *     "reactAuth": { "status": 0, "uidspx": "...", "berechtigungsobjekt": {...} }
 *
 *       0  zugelassen
 *       1  nicht für DIESE Anwendung zugelassen
 *       2  gar nicht für interne Anwendungen zugelassen
 *      -1  Claim fehlt oder ist unbrauchbar
 *
 * Zwei Dinge sind daran wichtig:
 *
 * 1. FEHLT DER CLAIM, GILT GESPERRT — nicht offen. Der Default ist -1, nicht 0.
 *    Genau diese Richtung entscheidet darüber, ob ein Fehler jemanden
 *    aussperrt oder hereinlässt. In Seschat steht dafür die Zeile
 *    `tokenParsed.reactAuth ?? { status: -1 }`.
 *
 * 2. DIESE PRÜFUNG HIER IST NUR BEQUEMLICHKEIT. Sie sorgt dafür, dass niemand
 *    in einer Anwendung landet, in der es für ihn nichts zu holen gibt. Wer sie
 *    im Browser umgeht, hat nichts gewonnen: Der Server prüft denselben Claim
 *    noch einmal, und zwar am signierten Token. Am Claim lässt sich nichts
 *    drehen, ohne die Signatur zu brechen.
 *
 * HIER ENDET DIESES PROJEKT. In Seschat folgt danach eine ZWEITE Prüfung: ein
 * Backend-Aufruf, der die Fachrollen liefert (ADMIN, BUCHHALTUNG, ANWENDER) und
 * darüber entscheidet, welche Bereiche sichtbar sind. Die ist hier absichtlich
 * nicht eingebaut.
 */
const checkReactAuth = () => {
  // Je nach Protocol Mapper landet der Claim im access_token, im id_token oder
  // in beiden. Deshalb beide ansehen und sagen, wo er gefunden wurde.
  const source = session.accessClaims?.reactAuth ? 'access_token' : session.idClaims?.reactAuth ? 'id_token' : null
  const reactAuth = source === 'access_token' ? session.accessClaims.reactAuth : source === 'id_token' ? session.idClaims.reactAuth : null

  const status = Number.isInteger(Number(reactAuth?.status)) ? Number(reactAuth.status) : -1
  const meanings = {
    0: 'allowed',
    1: 'not allowed for this application',
    2: 'not allowed for internal applications at all',
  }

  log('9. Checked reactAuth', {
    foundIn: source ?? 'nowhere — is the protocol mapper missing in the realm?',
    status,
    meaning: meanings[status] ?? 'unknown, treated as denied',
    access: status === 0 ? 'GRANTED' : 'DENIED',
  })

  return status === 0
}

// ============================================================================
//  §7  ENTRY POINT — what happens when the page loads
// ============================================================================

const loginButton = document.getElementById('login')
const refreshButton = document.getElementById('refresh')
const logoutButton = document.getElementById('logout')

/** Zeigt die Knöpfe, die im aktuellen Zustand sinnvoll sind. */
const updateButtons = loggedIn => {
  loginButton.hidden = loggedIn
  refreshButton.hidden = !loggedIn
  logoutButton.hidden = !loggedIn
}

const start = async () => {
  if (!config) {
    logError('config.js is missing. Copy config.example.js to config.js and fill in the three values.')
    loginButton.disabled = true
    return
  }

  // Weg A braucht `crypto.subtle` für die PKCE-Challenge, und das gibt es nur
  // im Secure Context. Weg B läuft hier weiter, weil keycloak-js SHA-256 selbst
  // mitbringt — deshalb der ausdrückliche Hinweis.
  if (!window.isSecureContext || !window.crypto?.subtle) {
    logError(
      `Not a secure context (${window.location.origin}). Without crypto.subtle the PKCE challenge ` +
        'cannot be computed. Open the page via http://localhost. Way B still works here.'
    )
    loginButton.disabled = true
    return
  }

  loginButton.addEventListener('click', () => {
    startLogin().catch(error => logError(error.message))
  })

  refreshButton.addEventListener('click', () => {
    refreshTokens().catch(error => {
      // Erneuern gescheitert = Sitzung vorbei. Kein automatischer Redirect —
      // in einem Lehrprojekt will man den Fehler lesen, nicht wegspringen.
      session = null
      updateButtons(false)
      logError(`${error.message} — please sign in again.`)
    })
  })

  logoutButton.addEventListener('click', logout)

  const callback = readCallbackFromUrl()

  if (!callback) {
    // Kein Rücksprung. Liegt trotzdem ein Anmeldeversuch herum, kam der letzte
    // Hinweg ohne Ergebnis zurück (Anmeldung abgebrochen, Zurück-Taste). Nur
    // aufräumen, NICHT von selbst neu starten — sonst dreht sich die Seite mit
    // dem Keycloak im Kreis.
    if (sessionStorage.getItem(STORAGE_KEY)) {
      sessionStorage.removeItem(STORAGE_KEY)
      log('The last login attempt came back without a code (cancelled?). Press the button to try again.')
    } else {
      log('Ready. Press the button to start the login.')
    }
    updateButtons(false)
    return
  }

  try {
    await handleCallback(callback)
    const granted = checkReactAuth()
    updateButtons(true)
    if (!granted) log('At this point a real application would show a denial page instead of its content.')
  } catch (error) {
    logError(error.message)
    updateButtons(false)
  }
}

await start()

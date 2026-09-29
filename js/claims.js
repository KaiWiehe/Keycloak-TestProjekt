// Kurzerklärung der Claims, die in einem Keycloak-Token typischerweise stehen.
// Wird von render.js für das kleine "?" an der Token-Ausgabe benutzt.
// Nur Top-Level-Keys; bei Objekten steht der Inhalt in der Erklärung.

export const CLAIM_HELP = {
  exp: 'Ablaufzeit (expiration) des Tokens, Unix-Sekunden. Danach lehnt der Server es ab.',
  iat: 'Ausstellungszeitpunkt (issued at), Unix-Sekunden.',
  nbf: 'Frühester Gültigkeitszeitpunkt (not before), Unix-Sekunden.',
  auth_time: 'Zeitpunkt der eigentlichen Anmeldung mit Passwort, Unix-Sekunden. Bleibt bei einem Refresh gleich.',
  jti: 'Eindeutige ID dieses Tokens (JWT ID). Damit lässt sich ein Token nachverfolgen oder sperren.',
  iss: 'Aussteller (issuer): die Realm-URL des Keycloak, der das Token signiert hat.',
  aud: 'Zielgruppe (audience): für welche Dienste das Token gedacht ist. Ein Backend sollte prüfen, dass es selbst dabei ist.',
  sub: 'Subject: die eindeutige, unveränderliche ID des Benutzers in Keycloak.',
  typ: 'Tokenart. Beim Access Token "Bearer", beim ID Token "ID".',
  azp: 'Authorized Party: die clientId, die das Token angefordert hat.',
  client_id: 'Die clientId, für die das Token ausgestellt wurde.',
  nonce: 'Zufallswert aus der Login-Anfrage. Beim Rücksprung wird verglichen, um ein untergeschobenes Token zu erkennen.',
  session_state: 'ID der SSO-Sitzung beim Keycloak (ältere Schreibweise von sid).',
  sid: 'ID der SSO-Sitzung beim Keycloak. Alle Anwendungen im selben Login teilen sie.',
  acr: 'Authentication Context Class Reference: wie stark die Anmeldung war (1 = normaler Login).',
  scope: 'Die freigegebenen Scopes, durch Leerzeichen getrennt, z. B. openid profile email.',
  'allowed-origins': 'Web Origins des Clients: von welchen Seiten aus CORS-Aufrufe erlaubt sind.',
  realm_access: 'Realm-Rollen des Benutzers, gültig im ganzen Realm (Feld "roles").',
  resource_access: 'Client-Rollen des Benutzers, aufgeteilt nach Client.',
  roles: 'Rollen des Benutzers, sofern ein Mapper sie direkt ins Token legt.',
  groups: 'Gruppen des Benutzers, sofern ein Mapper sie ins Token legt.',
  email: 'E-Mail-Adresse des Benutzers.',
  email_verified: 'Ob die E-Mail-Adresse bestätigt wurde.',
  name: 'Vollständiger Name des Benutzers.',
  given_name: 'Vorname.',
  family_name: 'Nachname.',
  preferred_username: 'Benutzername, wie er in Keycloak angezeigt und zum Login benutzt wird.',
  upn: 'User Principal Name, meist ein Benutzername oder eine E-Mail (z. B. aus Active Directory).',
  locale: 'Bevorzugte Sprache des Benutzers.',
  at_hash: 'Hash des Access Tokens im ID Token. Bindet beide Tokens aneinander.',
  c_hash: 'Hash des Authorization Codes im ID Token.',
  reactAuth:
    'Hauseigener Claim: status 0 = zugelassen, 1 = nicht für diese Anwendung, 2 = gar nicht für interne Anwendungen, fehlt = gesperrt.',
}

export const UNKNOWN_CLAIM = 'Nicht in der Liste — vermutlich ein eigener Claim aus einem Protocol Mapper des Realms.'

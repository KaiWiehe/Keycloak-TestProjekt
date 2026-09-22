/**
 * Vorlage für die Keycloak-Konfiguration.
 *
 * So benutzen:
 *   1. Diese Datei nach `config.js` kopieren.
 *   2. Die drei Werte eintragen.
 *   3. Seite neu laden.
 *
 * `config.js` steht in der .gitignore — echte Adressen gehören nicht in den
 * Quellcode. In Seschat kommen dieselben drei Werte vom Server, aus
 * `GET /Seschat/api/kc-config`. Dieses Projekt hat bewusst kein Backend,
 * deshalb stehen sie hier lokal.
 */
export const KEYCLOAK_CONFIG = {
  /** Basis-URL des Keycloak, OHNE `/realms/...`. Ein abschließender Schrägstrich ist egal. */
  url: 'https://keycloak.example.com/',

  /** Name des Realms. */
  realm: 'YOUR_REALM',

  /** Client-ID des Public Clients (kein Secret!). */
  clientId: 'YOUR_CLIENT_ID',
}

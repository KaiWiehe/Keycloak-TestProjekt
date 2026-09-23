| Key                  | Bedeutung                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `exp`                | **Expiration Time** – Zeitpunkt, wann das Token abläuft                                                                    |
| `iat`                | **Issued At** – Zeitpunkt, wann das Token erstellt wurde                                                                   |
| `nbf`                | **Not Before** – Token darf erst ab diesem Zeitpunkt benutzt werden                                                        |
| `jti`                | **JWT ID** – eindeutige ID dieses Tokens                                                                                   |
| `iss`                | **Issuer** – wer das Token ausgestellt hat, bei dir der Keycloak-Realm                                                     |
| `sub`                | **Subject** – eindeutige ID des Benutzers                                                                                  |
| `aud`                | **Audience** – für welchen Empfänger bzw. welche API das Token bestimmt ist                                                |
| `typ`                | Token-Typ, meistens `Bearer`                                                                                               |
| `azp`                | **Authorized Party** – der Client, der das Token angefordert hat                                                           |
| `sid`                | **Session ID** – Keycloak-Session des Benutzers                                                                            |
| `acr`                | Authentication Context Class Reference – grob gesagt, auf welchem Authentifizierungsniveau die Anmeldung stattgefunden hat |
| `scope`              | Berechtigungs-/Informationsbereiche wie `openid`, `profile`, `email`                                                       |
| `preferred_username` | Benutzername                                                                                                               |
| `email`              | E-Mail-Adresse                                                                                                             |
| `email_verified`     | Ob Keycloak die E-Mail als bestätigt betrachtet                                                                            |
| `given_name`         | Vorname                                                                                                                    |
| `family_name`        | Nachname                                                                                                                   |
| `name`               | vollständiger Name                                                                                                         |

# Keycloak-Testprojekt

Anmeldung bei Keycloak, zweimal dasselbe: einmal komplett von Hand, einmal mit `keycloak-js`.

**Die Erklärung steht im Code, nicht in der Oberfläche.** Die Seiten haben nur Knöpfe. Wer
verstehen will, was passiert, liest:

| Datei | Inhalt |
|---|---|
| [`js/manual.js`](js/manual.js) | Der komplette Authorization Code Flow mit PKCE als eigener Code |
| [`js/library.js`](js/library.js) | Derselbe Ablauf über `keycloak-js` — und was die Bibliothek dabei verbirgt |

Beide Dateien sind eigenständig: Jede lässt sich von oben nach unten lesen, ohne in eine andere
zu springen. Beide beginnen mit einer Landkarte des Ablaufs und sind in nummerierte Abschnitte
geteilt (`§0` bis `§7`), die der Reihenfolge des Flows folgen.

Bezeichner und Ausgaben sind englisch, die Kommentare deutsch. Plain HTML, CSS und JavaScript —
kein Framework, kein Bundler, kein Build, kein `npm install`.

---

## Loslegen

```bash
cp config.example.js config.js
```

Drei Werte eintragen (`url`, `realm`, `clientId`), dann:

```bash
node serve.js
```

http://localhost:4180 öffnen, einen der beiden Wege wählen, **Sign in** drücken.

Der Port ist fest. Die `redirect_uri` muss zeichengenau zu der passen, die im Keycloak-Client
steht — ein Server, der sich einen freien Port sucht, macht das Projekt unbenutzbar.

---

## Was man sieht

Beide Seiten schreiben jeden Schritt in die Browserkonsole **und** in das `<pre>` darunter. Der
Ablauf ist also lesbar, ohne die DevTools zu öffnen — interessant sind sie trotzdem:

- **Netzwerk-Tab**: zwei Vorgänge. `/auth` als Seitennavigation (der Hinweg), `/token` als POST
  (das Einlösen des Codes). Den POST zeigt `keycloak-js` sonst nirgends.
- **Storage**: Weg A legt seinen Anmeldeversuch unter `manual.loginAttempt` im `sessionStorage`
  ab, `keycloak-js` unter `kc-callback-<state>` im `localStorage`. Warum das einen Unterschied
  macht, steht in `js/manual.js §2`.
- Die **Adresszeile** direkt nach dem Rücksprung: Der `code` steht dort nur für Sekundenbruchteile,
  dann putzt ihn `history.replaceState` weg.

Nach einem Reload ist man wieder abgemeldet. Das ist kein Fehler — die Tokens liegen nur im
Arbeitsspeicher, nicht im Storage. Begründung in `js/manual.js §0`.

---

## Was im Keycloak-Client stehen muss

| Einstellung | Wert |
|---|---|
| Client-Typ | **Public Client**, kein Secret |
| Standard Flow | an |
| Valid Redirect URIs | `http://localhost:4180/*` |
| Valid post logout redirect URIs | `http://localhost:4180/*` |
| Web Origins | `http://localhost:4180` — **nicht `*`** |
| Protocol Mapper | einer, der `reactAuth` ins Token legt |

Jede Seite ist ein eigenes Redirect-Ziel (`/manual.html`, `/library.html`), weil die
`redirect_uri` immer die aufgerufene Seite ist. Mit dem Sternchen sind beide abgedeckt; stehen im
Client stattdessen einzelne Adressen, müssen beide eingetragen sein.

> **Web Origins nicht auf `*`.** `keycloak-js` schickt den Token-Request mit
> `withCredentials = true`; auf eine solche Anfrage darf der Browser keine Antwort mit
> `Access-Control-Allow-Origin: *` annehmen. Ergebnis: Weg B scheitert, Weg A läuft weiter.

> **`localhost` und `127.0.0.1` sind verschiedene Origins** — für CORS, für den
> `redirect_uri`-Abgleich und für den Storage. Dieses Projekt ist auf `localhost` ausgelegt.

---

## Wenn es klemmt

| Symptom | Ursache |
|---|---|
| „config.js is missing“ | `config.example.js` nach `config.js` kopieren |
| Keycloak: „Invalid parameter: redirect_uri“ | Die URI steht nicht im Client, oder der Port stimmt nicht |
| „Token endpoint unreachable“ | Keycloak nicht erreichbar **oder** CORS — der Browser verrät nicht welches. Netzwerk-Tab ansehen |
| Weg B scheitert, Weg A läuft | Fast immer Web Origins `*` |
| `reactAuth` → `status: -1` | Der Protocol Mapper fehlt im Realm. `-1` gilt als gesperrt, nicht als offen |
| Weg A: „Not a secure context“ | Über `http://localhost:4180` aufrufen, nicht über die IP. `crypto.subtle` gibt es nur im Secure Context — Weg B braucht ihn nicht, `keycloak-js` bringt SHA-256 selbst mit |
| Abmelden springt nicht zurück | Post-Logout-URI fehlt im Client |
| „Port 4180 is already in use“ | Es läuft noch ein `node serve.js` |

---

## Umfang

Das Projekt endet bei `reactAuth.status` — der Frage „darf dieser Mensch die Anwendung
benutzen?“. Was danach in Seschat folgt (Fachrollen aus einem Backend, Bereichs-Guards, Menü)
ist **nicht** eingebaut; das steht in `Seschat/KEYCLOAK_ANBINDUNG.md`.

Ebenfalls nicht eingebaut: eine Signaturprüfung im Browser. Die gehört auf den Server. Warum das
kein Versäumnis ist, steht im Kopf von `js/manual.js`.

---

## Dateien

```
serve.js               Statik-Server, Node ohne Abhängigkeiten, fester Port 4180
config.example.js      Vorlage für config.js (gitignored)
index.html             zwei Links
manual.html            ein paar Knöpfe und ein <pre>
library.html           dasselbe
js/manual.js           << der Lehrstoff
js/library.js          << der Lehrstoff
css/style.css          70 Zeilen, damit es nicht wehtut
vendor/keycloak.js     keycloak-js 24.0.2, unverändert (Apache 2.0)
```

Zur Herkunft von `vendor/keycloak.js` und warum es `keycloak.js` sein muss und nicht
`keycloak.mjs`: [`vendor/keycloak-LICENSE.txt`](vendor/keycloak-LICENSE.txt).

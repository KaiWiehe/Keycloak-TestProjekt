/**
 * Winziger Statik-Server für das Keycloak-Testprojekt.
 *
 * Warum überhaupt ein Server und nicht einfach die HTML-Datei doppelklicken:
 *  - Die `redirect_uri` muss ein gleichbleibender, im Keycloak-Client
 *    eingetragener Origin sein. `file://` hat keinen.
 *  - `crypto.subtle` (für die PKCE-Challenge) gibt es nur im Secure Context.
 *    `http://localhost` zählt als secure, `file://` und eine LAN-IP nicht.
 *  - ES-Module (`<script type="module">`) lädt der Browser unter `file://`
 *    nicht.
 *
 * Start: node serve.js
 * Keine Abhängigkeiten, kein npm install.
 */

const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')

/** Fest, weil er genau so im Keycloak-Client stehen muss. Siehe README. */
const PORT = 4180
const ROOT = __dirname

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const respond = (res, status, text) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname)
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath)

  // Verzeichnis-Traversal abweisen: alles muss unterhalb der Projektwurzel liegen.
  if (!path.resolve(filePath).startsWith(path.resolve(ROOT))) return respond(res, 403, 'Forbidden')

  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      // Ohne das hält der Browser beim Ausprobieren alte Stände fest und man
      // sucht Fehler, die es im Code längst nicht mehr gibt.
      'Cache-Control': 'no-store',
    })
    res.end(content)
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Genau der häufigste Fall: config.js wurde noch nicht angelegt.
      const hint =
        path.basename(filePath) === 'config.js'
          ? 'config.js is missing. Copy config.example.js to config.js and fill in your values.'
          : `Not found: ${urlPath}`
      return respond(res, 404, hint)
    }
    respond(res, 500, `Server error: ${error.message}`)
  }
})

server.listen(PORT, () => {
  process.stdout.write(`Keycloak test project running at http://localhost:${PORT}\n`)
  process.stdout.write('Stop with Ctrl+C\n')
})

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `Port ${PORT} is already in use. Either stop the other process, or change PORT in serve.js —\n` +
        'but then the new port also has to be registered in the Keycloak client.\n'
    )
    process.exit(1)
  }
  throw error
})

// Darstellung der Ausgabe: ein Eintrag pro Schritt, JSON eingerückt und farbig.
// Nur Anzeige. Der Ablauf steht in manual.js und library.js.
//
// Alles läuft über createElement/textContent, nie über innerHTML — Token-Inhalte
// landen also nie als Markup auf der Seite.

const TIME_KEYS = new Set(['exp', 'iat', 'nbf', 'auth_time'])

const span = (className, text) => {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

/** Ein Wert samt Einrückung als DOM-Knoten. `key` dient nur der Zeitanzeige. */
const renderValue = (value, depth, key) => {
  const fragment = document.createDocumentFragment()
  const indent = '  '.repeat(depth)

  if (value === null) {
    fragment.append(span('j-null', 'null'))
  } else if (Array.isArray(value) || typeof value === 'object') {
    const isArray = Array.isArray(value)
    const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value)
    const [open, close] = isArray ? ['[', ']'] : ['{', '}']
    if (entries.length === 0) {
      fragment.append(open + close)
    } else {
      fragment.append(`${open}\n`)
      entries.forEach(([entryKey, entryValue], index) => {
        fragment.append(`${indent}  `)
        if (!isArray) {
          fragment.append(span('j-key', JSON.stringify(entryKey)), ': ')
        }
        fragment.append(renderValue(entryValue, depth + 1, entryKey))
        fragment.append(index < entries.length - 1 ? ',\n' : '\n')
      })
      fragment.append(`${indent}${close}`)
    }
  } else if (typeof value === 'string') {
    const text = JSON.stringify(value)
    if (value === 'GRANTED' || value === 'DENIED') {
      fragment.append(span(`badge ${value === 'GRANTED' ? 'ok' : 'bad'}`, value))
    } else {
      fragment.append(span('j-str', text))
    }
  } else if (typeof value === 'number') {
    fragment.append(span('j-num', String(value)))
    if (TIME_KEYS.has(key) && value > 1e9) {
      fragment.append(span('j-hint', `  // ${new Date(value * 1000).toLocaleString()}`))
    }
  } else if (typeof value === 'boolean') {
    fragment.append(span('j-bool', String(value)))
  } else {
    fragment.append(String(value))
  }
  return fragment
}

/** Gleiche Signatur wie die alten log/logError, damit die Aufrufer gleich bleiben. */
export const createLogger = (outputElement, prefix) => {
  const log = (message, data) => {
    const text = data === undefined || typeof data === 'string' ? '' : JSON.stringify(data, null, 2)
    console.log(`[${prefix}] ${data === undefined ? message : `${message}\n${typeof data === 'string' ? data : text}`}`)

    const entry = document.createElement('section')
    entry.className = message.startsWith('ERROR:') ? 'entry error' : 'entry'

    const title = document.createElement('h2')
    title.textContent = message
    entry.append(title)

    if (data !== undefined) {
      const body = document.createElement('pre')
      if (typeof data === 'string') {
        body.textContent = data
      } else {
        body.append(renderValue(data, 0))
      }
      entry.append(body)
    }
    outputElement.append(entry)
  }

  const logError = message => log(`ERROR: ${message}`)
  return { log, logError }
}

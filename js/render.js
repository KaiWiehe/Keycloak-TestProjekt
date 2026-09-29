// Darstellung der Ausgabe: ein Eintrag pro Schritt, JSON eingerückt und farbig.
// Nur Anzeige. Der Ablauf steht in manual.js und library.js.
//
import { UNKNOWN_CLAIM } from './claims.js'

// Alles läuft über createElement/textContent, nie über innerHTML — Token-Inhalte
// landen also nie als Markup auf der Seite.

// Unix-Sekunden erkennt man am Wert, nicht am Key: exp, iat, nbf, auth_time,
// aber auch expBefore/expAfter usw. Der Bereich (2001 bis 2286) trifft keine
// Längen, Zähler oder Laufzeiten.
const isUnixSeconds = value => Number.isInteger(value) && value >= 1e9 && value < 1e10

const span = (className, text) => {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

/** Ein Wert samt Einrückung als DOM-Knoten. */
const renderValue = (value, depth) => {
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
        fragment.append(renderValue(entryValue, depth + 1))
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
    if (isUnixSeconds(value)) {
      fragment.append(span('j-hint', `  // ${new Date(value * 1000).toLocaleString()}`))
    }
  } else if (typeof value === 'boolean') {
    fragment.append(span('j-bool', String(value)))
  } else {
    fragment.append(String(value))
  }
  return fragment
}

/** Aufklappbare Liste "Key: Erklärung" für alle Top-Level-Keys von `data`. */
const renderHelp = (data, help) => {
  const list = document.createElement('dl')
  list.className = 'help'
  list.hidden = true
  for (const key of Object.keys(data)) {
    const term = document.createElement('dt')
    term.append(span('j-key', key))
    const description = document.createElement('dd')
    description.textContent = help[key] ?? UNKNOWN_CLAIM
    list.append(term, description)
  }
  return list
}

/**
 * Gleiche Signatur wie die alten log/logError, damit die Aufrufer gleich bleiben.
 * Mit `help` (Key -> Erklärung) bekommt der Eintrag ein kleines "?", das die
 * Erklärungen zu den Keys der Daten ein- und ausblendet.
 */
export const createLogger = (outputElement, prefix) => {
  const log = (message, data, help) => {
    const text = data === undefined || typeof data === 'string' ? '' : JSON.stringify(data, null, 2)
    console.log(`[${prefix}] ${data === undefined ? message : `${message}\n${typeof data === 'string' ? data : text}`}`)

    const entry = document.createElement('section')
    entry.className = message.startsWith('ERROR:') ? 'entry error' : 'entry'

    const title = document.createElement('h2')
    title.textContent = message
    entry.append(title)

    const helpList = help && data && typeof data === 'object' ? renderHelp(data, help) : null
    if (helpList) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'help-toggle'
      toggle.textContent = '?'
      toggle.title = 'Keys erklären'
      toggle.setAttribute('aria-expanded', 'false')
      toggle.addEventListener('click', () => {
        helpList.hidden = !helpList.hidden
        toggle.setAttribute('aria-expanded', String(!helpList.hidden))
      })
      title.append(' ', toggle)
      entry.append(helpList)
    }

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

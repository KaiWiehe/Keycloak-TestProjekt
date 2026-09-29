// Konfiguration ansehen und live ändern — gemeinsam für manual.js und library.js.
//
// Die Werte aus config.js sind der Ausgangspunkt. Was man im Formular ändert,
// liegt als Überschreibung im localStorage und gilt für beide Seiten. Das muss
// den Redirect zum Keycloak und zurück überleben, deshalb kein Speicher, der nur
// in einer Variablen lebt.
//
// Nach dem Übernehmen wird die Seite neu geladen: Die Tokens gehören zum alten
// Client und sind danach ohnehin wertlos, und beide Abläufe lesen die
// Konfiguration nur beim Start.

const OVERRIDE_KEY = 'kc.configOverride'
const HISTORY_KEY = 'kc.clientIdHistory'
const FIELDS = [
  { name: 'url', label: 'Keycloak URL', hint: 'ohne /realms/...' },
  { name: 'realm', label: 'Realm' },
  { name: 'clientId', label: 'Client ID', hint: 'Public Client, kein Secret', history: true },
]

// localStorage kann fehlen oder werfen (Privatmodus, gesperrte Website-Daten).
const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ohne Speicher bleibt die Änderung wirkungslos — das Formular zeigt dann
    // nach dem Neuladen wieder die Werte aus config.js.
  }
}

/**
 * Liefert die aktive Konfiguration, die Vorlage aus config.js und die
 * Überschreibung. `config` ist null, wenn es weder Vorlage noch Überschreibung gibt.
 */
export const loadConfig = async () => {
  const base = await import('../config.js')
    .then(module => module.KEYCLOAK_CONFIG)
    .catch(() => null)
  const override = readJson(OVERRIDE_KEY, null)
  const config = base || override ? { ...base, ...override } : null
  const complete = config && FIELDS.every(({ name }) => typeof config[name] === 'string' && config[name].trim())
  return { config: complete ? config : null, base, override }
}

const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** Zeichnet das Formular in `container`. */
export const mountConfigPanel = (container, { config, base, override }) => {
  const history = readJson(HISTORY_KEY, [])
  if (config?.clientId && !history.includes(config.clientId)) history.push(config.clientId)

  const inputs = {}
  const form = element('form', { className: 'config-form', autocomplete: 'off' })

  for (const { name, label, hint, history: withHistory } of FIELDS) {
    const input = element('input', { name, value: config?.[name] ?? base?.[name] ?? '', required: true, spellcheck: false })
    if (withHistory) {
      input.setAttribute('list', 'client-id-history')
      form.append(element('datalist', { id: 'client-id-history' }, ...history.map(value => element('option', { value }))))
    }
    inputs[name] = input
    form.append(element('label', {}, element('span', {}, label, hint ? element('small', {}, ` ${hint}`) : '' ), input))
  }

  const message = element('p', { className: 'config-message', role: 'alert' })
  const apply = element('button', { type: 'submit', id: 'config-apply' }, 'Übernehmen und neu laden')
  const reset = element('button', { type: 'button', disabled: !override }, 'Zurücksetzen auf config.js')
  form.append(element('div', { className: 'actions' }, apply, reset), message)

  form.addEventListener('submit', event => {
    event.preventDefault()
    const values = Object.fromEntries(FIELDS.map(({ name }) => [name, inputs[name].value.trim()]))
    try {
      new URL(values.url)
    } catch {
      message.textContent = 'Keycloak URL ist keine gültige Adresse (mit https://).'
      return
    }
    writeJson(OVERRIDE_KEY, values)
    writeJson(HISTORY_KEY, [...new Set([...history, values.clientId])])
    window.location.assign(`${window.location.origin}${window.location.pathname}`)
  })

  reset.addEventListener('click', () => {
    try {
      localStorage.removeItem(OVERRIDE_KEY)
    } catch {
      // siehe writeJson
    }
    window.location.assign(`${window.location.origin}${window.location.pathname}`)
  })

  const status = override ? 'Überschrieben im Browser' : base ? 'Aus config.js' : 'config.js fehlt — hier eintragen'
  container.replaceChildren(
    element(
      'details',
      { className: 'config', open: !config },
      element('summary', {}, 'Konfiguration', element('small', {}, ` — ${status}${config ? `, Client: ${config.clientId}` : ''}`)),
      form
    )
  )
}

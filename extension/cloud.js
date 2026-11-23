chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (request.action !== 'translate' || sender.frameId !== 0 ||
      sender.origin !== 'https://chat.zalo.me') return
  if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 5000 ||
      !['ru', 'vi', 'en'].includes(request.target) ||
      ![undefined, 'ru'].includes(request.source)) {
    reply({ ok: false, message: 'Для облачного перевода доступен текст до 5000 символов.' })
    return
  }
  translate(request).then(text => reply({ ok: true, text }), error => {
    reply({ ok: false, message: error.userMessage || 'Облачный перевод недоступен. Повторите попытку.' })
  })
  return true
})

async function translate({ text, source, target }) {
  const { cloudKey } = await chrome.storage.local.get('cloudKey')
  if (!cloudKey) throw { userMessage: 'Облачный перевод настраивается в меню расширения.' }
  const response = await fetch('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': cloudKey },
    body: JSON.stringify({ q: text, target, source, format: 'text' }),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw {
    userMessage: [400, 401, 403].includes(response.status)
      ? 'Проверьте ключ и доступ к Google Cloud Translation в настройках.'
      : 'Google Cloud временно недоступен или достигнут лимит.'
  }
  const result = (await response.json()).data?.translations?.[0]?.translatedText
  if (typeof result !== 'string' || !result.trim()) throw new Error('Missing translation')
  return result
}

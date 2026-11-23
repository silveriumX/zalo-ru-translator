const zaloTranslate = (() => {
  const translators = new Map()
  const ready = new Set()
  let detector

  function watch(update) {
    return monitor => monitor.addEventListener('downloadprogress', event => {
      if (event.loaded < 1) update('Загрузка языка Chrome…')
    })
  }

  function requireGesture(resource) {
    if (!navigator.userActivation.isActive) {
      const error = new Error('Нажмите «Перевести», чтобы загрузить язык')
      error.resource = resource
      throw error
    }
  }

  async function create(factory, options) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Chrome ещё загружает язык. Повторите перевод.', 'TimeoutError'))
    }, 60000)
    try {
      return await factory.create({ ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function detect(text, update) {
    if (!globalThis.LanguageDetector) throw new Error('Распознавание языка недоступно в этом Chrome')
    if (!detector) {
      const availability = await LanguageDetector.availability()
      if (availability === 'unavailable') throw new Error('Распознавание языка недоступно в этом Chrome')
      if (availability !== 'available') requireGesture('detector')
      detector ??= create(LanguageDetector, { monitor: watch(update) }).then(instance => {
        ready.add('detector')
        return instance
      }).catch(error => {
        detector = undefined
        throw error
      })
    }
    const results = await (await detector).detect(text)
    const code = results.find(result => result.detectedLanguage !== 'und')?.detectedLanguage
    if (!code) throw new Error('Не удалось определить язык короткого сообщения')
    if (/^zh-(hant|tw|hk)/i.test(code)) return 'zh-Hant'
    return code.split('-')[0]
  }

  function unsupported(message) {
    const error = new Error(message)
    error.cloudEligible = true
    return error
  }

  async function translate(text, target, source, cloud, update) {
    if (cloud) {
      const response = await chrome.runtime.sendMessage({ action: 'translate', text, source, target })
      if (!response?.ok) throw new Error(response?.message || 'Облачный перевод недоступен')
      return response.text
    }
    if (!globalThis.Translator) throw unsupported('Перевод недоступен в этом Chrome. Можно отправить текст в Google для перевода.')
    source ||= await detect(text, update)
    if (source === target) return text
    const pair = source + ':' + target
    const options = { sourceLanguage: source, targetLanguage: target, monitor: watch(update) }
    if (!translators.has(pair)) {
      const availability = await Translator.availability(options)
      if (availability === 'unavailable') throw unsupported('Chrome не поддерживает этот язык. Можно отправить текст в Google для перевода.')
      if (!translators.has(pair)) {
        if (availability !== 'available') requireGesture(pair)
        translators.set(pair, create(Translator, options).then(instance => {
          ready.add(pair)
          return instance
        }).catch(error => {
          translators.delete(pair)
          throw error
        }))
      }
    }
    return (await translators.get(pair)).translate(text)
  }

  return { translate, isReady: resource => ready.has(resource) }
})()

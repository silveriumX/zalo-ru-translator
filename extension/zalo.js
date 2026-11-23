(() => {
  const textSelector = '[data-component="message-text-content"]'
  const modes = { vi: 'Вьетнамский', en: 'Английский', off: 'Оригинал' }
  const messages = new WeakMap()
  const cache = new Map()
  const visible = new Set()
  let activeJobs = 0
  let mode = 'vi'
  let incoming = true
  let bar
  let editor
  let draftVersion = 0
  let scheduled = false
  let preview

  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag)
    node.textContent = text
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    return node
  }

  function button(label, action) {
    const node = element('button', label, { type: 'button' })
    node.addEventListener('click', event => {
      if (event.isTrusted) action()
    })
    return node
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      mount()
      findMessages()
      pump()
    })
  }

  function mount() {
    const current = document.querySelector('#chatInput #richInput[contenteditable="true"]')
    if (editor === current && bar?.root.isConnected) {
      if (preview && (!sameThread(preview.conversation) || read(editor) !== preview.translated)) {
        preview = undefined
        resetBar()
      }
      if (bar.job && !bar.job.current()) {
        bar.job = undefined
        resetBar()
      }
      if (bar.offer && !bar.offer()) resetBar()
      return
    }
    bar?.root.remove()
    bar = undefined
    preview = undefined
    editor = current
    if (!editor) return

    const root = element('section', '', { class: 'zru-bar', 'aria-label': 'Перевод Zalo' })
    const row = element('div', '', { class: 'zru-controls' })
    const label = element('label', 'Ответ ', { class: 'zru-select-label' })
    const select = element('select', '', { 'aria-label': 'Язык ответа' })
    for (const [value, label] of Object.entries(modes)) select.append(element('option', label, { value }))
    select.value = mode
    select.addEventListener('change', () => chrome.storage.sync.set({ mode: select.value }))

    const primary = button('Перевести ответ', () => prepare(false))
    const cloud = button('Через Google', () => prepare(true))
    const undo = button('Вернуть оригинал', restore)
    const inboundLabel = element('label', '', { class: 'zru-incoming-label' })
    const inbound = element('input', '', { type: 'checkbox' })
    inbound.checked = incoming
    inbound.addEventListener('change', () => chrome.storage.sync.set({ incoming: inbound.checked }))
    inboundLabel.append(inbound, document.createTextNode('Входящие на русском'))
    const status = element('div', '', { class: 'zru-status', role: 'status' })
    label.append(select)
    row.append(label, primary, undo, cloud, inboundLabel)
    root.append(row, status)
    editor.closest('#chatInput').prepend(root)
    bar = { root, select, primary, undo, cloud, status, inbound }
    resetBar()
  }

  function resetBar() {
    if (!bar) return
    bar.select.value = mode
    bar.inbound.checked = incoming
    bar.primary.hidden = mode === 'off'
    bar.primary.disabled = Boolean(bar.job)
    bar.cloud.hidden = true
    bar.offer = undefined
    bar.undo.hidden = true
    bar.status.textContent = ''
  }

  function thread() {
    const selected = document.querySelector('.conv-item.selected')
    const header = document.querySelector('#header')
    return [location.href, selected, selected?.closest('[data-id]')?.getAttribute('data-id'),
      header, header?.querySelector('[class*=name]')?.textContent, document.querySelector('#messageViewScroll')]
  }

  function sameThread(before) {
    return thread().every((value, index) => value === before[index])
  }

  function read(input) {
    return input.innerText.replace(/\r\n/g, '\n')
  }

  function replace(input, value) {
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return document.execCommand('insertText', false, value)
  }

  async function prepare(cloud) {
    if (!editor || !bar || mode === 'off' || bar.job || preview) return
    if (cloud && !bar.offer?.()) return
    const input = editor
    const original = read(input)
    if (!original.trim()) {
      bar.status.textContent = 'Напишите ответ в поле Zalo.'
      input.focus()
      return
    }
    if (input.querySelector('[contenteditable="false"], img, a, [style], b, i, strong, em, u, ul, ol')) {
      bar.status.textContent = 'Перевод ответа доступен для обычного текста.'
      return
    }
    const session = bar
    const target = mode
    const version = draftVersion
    const conversation = thread()
    const stillCurrent = () => session === bar && input.isConnected && draftVersion === version &&
      target === mode && sameThread(conversation) && read(input) === original
    const job = { current: stillCurrent }
    session.job = job
    session.offer = undefined
    session.primary.disabled = true
    session.cloud.hidden = true
    session.status.textContent = 'Переводим ответ…'
    try {
      const result = await zaloTranslate.translate(original, target, 'ru', cloud, status => {
        if (stillCurrent()) session.status.textContent = status
      })
      if (!stillCurrent()) return
      if (!result?.trim() || !replace(input, result)) throw new Error('Перевод не удалось вставить. Повторите попытку.')
      preview = { input, source: original, translated: read(input), conversation }
      session.primary.hidden = true
      session.undo.hidden = false
      session.status.textContent = 'Перевод в поле Zalo. Проверьте текст и отправьте обычной кнопкой.'
    } catch (error) {
      if (!stillCurrent()) return
      session.status.textContent = error.message || 'Не удалось перевести ответ.'
      if (!cloud) {
        session.offer = stillCurrent
        session.cloud.hidden = false
      }
    } finally {
      if (session.job === job) {
        session.job = undefined
        session.primary.disabled = false
        if (session === bar && !preview && !stillCurrent()) resetBar()
      }
    }
  }

  function restore() {
    if (preview?.input === editor && sameThread(preview.conversation) &&
        read(editor) === preview.translated) replace(editor, preview.source)
    preview = undefined
    resetBar()
  }

  document.addEventListener('input', event => {
    if (event.target !== editor) return
    draftVersion++
    const shouldReset = preview || bar?.offer
    preview = undefined
    if (shouldReset) resetBar()
  }, true)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (changes.mode) {
      restore()
      mode = Object.hasOwn(modes, changes.mode.newValue) ? changes.mode.newValue : 'vi'
    }
    if (changes.incoming) incoming = changes.incoming.newValue !== false
    if (!preview) resetBar()
    else bar.inbound.checked = incoming
    schedule()
  })

  const intersection = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) visible.add(target)
      else visible.delete(target)
    }
    pump()
  })

  function findMessages() {
    const list = document.querySelector('#messageViewScroll')
    for (const target of visible) {
      if (!target.isConnected) {
        visible.delete(target)
        intersection.unobserve(target)
      }
    }
    if (!list) return
    for (const text of list.querySelectorAll(textSelector)) {
      const row = text.closest('.chat-message')
      const received = row && !row.matches('.me') && !row.querySelector('.message-wrapper--me')
      const original = read(text).trim()
      let state = messages.get(text)
      if (state && (!received || state.original !== original)) {
        state.box?.remove()
        intersection.unobserve(text)
        visible.delete(text)
        messages.delete(text)
        state = undefined
      }
      if (!state && received && /\p{L}/u.test(original)) {
        messages.set(text, { original })
        intersection.observe(text)
      }
      if (state?.box && state.box.hidden === incoming) state.box.hidden = !incoming
    }
  }

  function pump() {
    if (!incoming) return
    for (const text of visible) {
      if (activeJobs >= 3) return
      const state = messages.get(text)
      if (state && (!state.started || zaloTranslate.isReady(state.waitingFor)) && text.isConnected) {
        void translateMessage(text, state)
      }
    }
  }

  async function translateMessage(text, state, clicked = false, cloud = false) {
    const row = text.closest('.chat-message')
    const current = () => text.isConnected && messages.get(text) === state &&
      !row?.matches('.me') && !row?.querySelector('.message-wrapper--me') && read(text).trim() === state.original
    if (state.running || !current() || !incoming) return
    state.started = true
    state.running = true
    state.waitingFor = undefined
    activeJobs++
    const show = (...nodes) => {
      if (!current()) return
      if (!state.box?.isConnected) {
        state.box = element('div', '', { class: 'zru-translation', lang: 'ru' })
        text.after(state.box)
      }
      state.box.hidden = !incoming
      state.box.replaceChildren(...nodes)
    }

    if (clicked) show('Переводим…')
    try {
      const key = (cloud ? 'cloud:' : 'local:') + state.original
      let result = cache.get(key)
      if (result === undefined) {
        result = await zaloTranslate.translate(state.original, 'ru', undefined, cloud, show)
        if (cache.size >= 300) cache.delete(cache.keys().next().value)
        cache.set(key, result)
      }
      if (result.trim() !== state.original) show(element('span', result, { class: 'zru-result' }))
      else state.box?.remove()
    } catch (error) {
      const retry = button('Перевести', () => translateMessage(text, state, true))
      state.waitingFor = error.resource
      if (!clicked) show(retry)
      else show(error.name === 'TimeoutError' ? 'Chrome ещё загружает язык. Повторите перевод.' :
        error.message || 'Перевод недоступен.', retry,
      button('Через Google', () => translateMessage(text, state, true, true)))
    } finally {
      state.running = false
      activeJobs--
      pump()
    }
  }

  chrome.storage.sync.get({ mode: 'vi', incoming: true }).then(settings => {
    mode = Object.hasOwn(modes, settings.mode) ? settings.mode : 'vi'
    incoming = settings.incoming !== false
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'data-id', 'contenteditable']
    })
    schedule()
  })
})()

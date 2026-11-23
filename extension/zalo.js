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
  let lastDispatch

  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag)
    node.textContent = text
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    return node
  }

  function button(label, action) {
    const node = element('button', label, { type: 'button' })
    node.addEventListener('click', event => {
      if (!event.isTrusted) return
      event.stopPropagation()
      action()
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
      if (bar.job && !bar.job.dispatched && !bar.job.current()) cancelJob(bar)
      if (bar.offer && !bar.offer()) bar.offer = undefined
      renderAction()
      return
    }
    bar?.root.remove()
    bar = undefined
    lastDispatch = undefined
    editor = current
    if (!editor) return

    const root = element('section', '', { class: 'zru-bar', 'aria-label': 'Перевод Zalo' })
    const isBlank = event => !event.target.closest('button, select, label, input')
    root.addEventListener('pointerdown', event => {
      if (isBlank(event)) event.preventDefault()
    })
    root.addEventListener('click', event => {
      if (isBlank(event)) event.stopPropagation()
    })
    const row = element('div', '', { class: 'zru-controls' })
    const label = element('label', 'Ответ ', { class: 'zru-select-label' })
    const select = element('select', '', { 'aria-label': 'Язык ответа' })
    for (const [value, label] of Object.entries(modes)) select.append(element('option', label, { value }))
    select.value = mode
    select.addEventListener('change', () => {
      changeMode(select.value)
      void chrome.storage.sync.set({ mode })
    })

    const direct = button('Отправить перевод', () => void prepare())
    direct.className = 'zru-send'
    // Zalo redraws the panel when its editor loses focus during a mouse press.
    // Keep the editor focused until the button receives its click.
    direct.addEventListener('mousedown', event => event.preventDefault())
    const inboundLabel = element('label', '', { class: 'zru-incoming-label' })
    const inbound = element('input', '', { type: 'checkbox' })
    inbound.checked = incoming
    inbound.addEventListener('change', () => chrome.storage.sync.set({ incoming: inbound.checked }))
    inboundLabel.append(inbound, document.createTextNode('Входящие на русском'))
    const status = element('div', '', { class: 'zru-status', role: 'status' })
    label.append(select)
    const actions = element('div', '', { class: 'zru-actions' })
    actions.append(label, direct)
    row.append(actions, inboundLabel)
    root.append(row, status)
    editor.closest('#chatInput').before(root)
    bar = { root, select, direct, status, inbound }
    renderAction()
  }

  function renderAction() {
    if (!bar || !editor) return
    const empty = !read(editor).trim()
    const label = bar.job?.phase || (bar.offer ? 'Отправить через Google' : 'Отправить перевод')
    bar.direct.hidden = mode === 'off'
    bar.direct.disabled = Boolean(bar.job) || empty
    bar.direct.title = empty ? 'Сначала напишите ответ' : label
    if (bar.direct.textContent !== label) bar.direct.textContent = label
  }

  function nativeSendButton() {
    return editor?.closest('#chatInput')?.querySelector('#normal-buttons-group-id .send-msg-btn')
  }

  function blockingDialog() {
    return [...document.querySelectorAll('.zl-modal')].some(modal =>
      !modal.closest('[hidden], [aria-hidden="true"], [inert]') &&
      modal.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      modal.getClientRects().length
    )
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

  function restoreDraft(job) {
    const draft = job.prepared
    if (draft && !job.dispatched && job.input === editor && job.input.isConnected &&
        sameThread(job.conversation) && draft.version === draftVersion && read(editor) === draft.text) {
      replace(editor, job.original)
    }
  }

  function cancelJob(session) {
    const job = session.job
    session.job = undefined
    restoreDraft(job)
    session.status.textContent = 'Отправка отменена. Проверьте чат и текст ответа.'
    renderAction()
  }

  function changeMode(value) {
    if (value === mode) return
    if (bar?.job) cancelJob(bar)
    mode = Object.hasOwn(modes, value) ? value : 'vi'
    if (!bar) return
    bar.select.value = mode
    bar.offer = undefined
    bar.status.textContent = ''
    renderAction()
  }

  async function prepare() {
    if (!editor || !bar || mode === 'off' || bar.job) return
    const session = bar
    if (blockingDialog()) {
      session.status.textContent = 'Закройте открытое окно Zalo и нажмите ещё раз.'
      return
    }
    const input = editor
    const original = read(input)
    if (!original.trim()) return
    if (input.querySelector('[contenteditable="false"], img, a, b, i, strong, em, u, ul, ol, [data-mention-id], [data-uid]')) {
      session.status.textContent = 'Для перевода используйте обычный текст без вложенных элементов.'
      return
    }
    const target = mode
    const version = draftVersion
    const conversation = thread()
    const cloud = Boolean(session.offer?.())
    if (lastDispatch?.input === input && lastDispatch.version === version &&
        lastDispatch.text === original && sameThread(lastDispatch.conversation)) {
      session.status.textContent = 'Команда уже передана Zalo. Проверьте сообщение в чате.'
      return
    }
    const locationMatches = () => session === bar && input === editor && input.isConnected &&
      target === mode && session.select.value === target && sameThread(conversation) && !blockingDialog()
    const originalMatches = () => locationMatches() && draftVersion === version && read(input) === original
    const job = {
      input, original, conversation, phase: 'Переводим…',
      current: () => locationMatches() && (job.prepared
        ? draftVersion === job.prepared.version && read(input) === job.prepared.text
        : originalMatches())
    }
    const isActive = () => session.job === job && job.current()
    const checkActive = () => {
      if (isActive()) return true
      if (session === bar && session.job === job) cancelJob(session)
      return false
    }
    session.job = job
    session.offer = undefined
    session.status.textContent = 'Переводим ответ…'
    renderAction()
    try {
      const result = await zaloTranslate.translate(original, target, 'ru', cloud, status => {
        if (isActive()) session.status.textContent = status
      })
      if (!checkActive()) return
      if (!result?.trim()) throw new Error('Перевод получился пустым.')
      if (result.trim() === original.trim() && /\p{Script=Cyrillic}/u.test(original)) {
        throw new Error('Перевод совпал с оригиналом. Сообщение не отправлено.')
      }
      const inserted = replace(input, result)
      job.prepared = { text: read(input), version: draftVersion }
      if (!inserted || job.prepared.text.trim() !== result.replace(/\r\n/g, '\n').trim()) {
        throw new Error('Zalo не принял переведённый текст.')
      }
      job.phase = 'Отправляем…'
      session.status.textContent = 'Передаём перевод в Zalo…'
      renderAction()
      for (let attempt = 0; attempt < 18; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        if (!checkActive()) return
        const native = nativeSendButton()
        if (native?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
            !native.matches(':disabled, [aria-disabled="true"], .disabled, .--disabled')) {
          job.dispatched = true
          lastDispatch = { input, conversation, ...job.prepared }
          session.status.textContent = 'Команда отправки передана Zalo.'
          native.click()
          return
        }
      }
      throw new Error('Кнопка отправки Zalo недоступна. Исходный текст сохранён.')
    } catch (error) {
      if (session !== bar || session.job !== job) return
      session.status.textContent = error.name === 'NotAllowedError'
        ? 'Chrome ждёт повторного нажатия, чтобы загрузить язык.'
        : error.message || 'Не удалось перевести ответ.'
      if ((cloud || error.cloudEligible) && originalMatches()) session.offer = originalMatches
    } finally {
      if (session.job === job) {
        session.job = undefined
        restoreDraft(job)
        renderAction()
      }
    }
  }

  document.addEventListener('input', event => {
    if (event.target !== editor) return
    draftVersion++
    lastDispatch = undefined
    if (bar?.offer) {
      bar.offer = undefined
      bar.status.textContent = ''
    }
    renderAction()
  }, true)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (changes.mode) changeMode(changes.mode.newValue)
    if (changes.incoming) {
      incoming = changes.incoming.newValue !== false
      if (bar) bar.inbound.checked = incoming
    }
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

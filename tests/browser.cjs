const assert = require('node:assert/strict')
const { mkdtemp, cp, rm, writeFile, readFile, mkdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const real = process.argv.includes('--real')
const evidence = process.env.ZALO_EVIDENCE || '/tmp/zalo-extension-evidence'

async function launchStockChrome(binary, profile, extension) {
  const process = spawn(binary, [
    '--headless', '--remote-debugging-pipe', '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  try {
    const loaded = new Promise((resolve, reject) => {
      let buffer = ''
      process.once('error', reject)
      process.once('exit', () => reject(new Error('Chrome closed during startup')))
      process.stdio[4].on('data', data => {
        buffer += data
        const records = buffer.split('\0')
        buffer = records.pop()
        for (const record of records) {
          const reply = JSON.parse(record)
          if (reply.id === 1 && reply.error) reject(new Error(reply.error.message))
          if (reply.id === 1 && reply.result?.id) resolve()
        }
      })
    })
    process.stdio[3].write(JSON.stringify({
      id: 1, method: 'Extensions.loadUnpacked', params: { path: extension }
    }) + '\0')
    await loaded
    const port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
    return { context: browser.contexts()[0], process }
  } catch (error) {
    process.kill()
    throw error
  }
}

async function main() {
  const temp = await mkdtemp(path.join(tmpdir(), 'zalo-test-'))
  let context
  let stock
  try {
    const extension = path.join(temp, 'extension')
    await cp(path.join(__dirname, '../extension'), extension, { recursive: true })
    if (!real) {
      const file = path.join(extension, 'translator.js')
      await writeFile(file, `
        const testSend = chrome.runtime.sendMessage.bind(chrome.runtime)
        chrome.runtime.sendMessage = (...args) => {
          const data = document.documentElement.dataset
          data.cloudRequests = String(Number(data.cloudRequests || 0) + 1)
          return testSend(...args)
        }
        globalThis.LanguageDetector = {
          availability: async () => 'available',
          create: async () => ({ detect: async text => [{ detectedLanguage: text.startsWith('Xin') ? 'vi' : 'en' }] })
        }
        globalThis.Translator = {
          availability: async ({sourceLanguage}) =>
            sourceLanguage === 'ru' && document.body.dataset.localUnsupported ? 'unavailable' : 'available',
          create: async ({targetLanguage}) => ({
            translate: async text => {
              await new Promise(resolve => setTimeout(resolve, text === 'Привет!' ? 650 : 250))
              if (targetLanguage !== 'ru') document.documentElement.dataset.lastTranslated = text
              if (text.includes('СОВПАДЕНИЕ')) return text
              if (text.includes('ОШИБКА')) throw new Error('Тестовая ошибка.')
              if (targetLanguage === 'ru') return text.startsWith('Xin') ? 'Привет! Ты завтра свободен?' : 'Привет! Пришлите адрес.'
              return (targetLanguage === 'vi' ? 'Chào' : 'Hello') + '\\n' + text.split('\\n').slice(1).join('\\n')
            }
          })
        }
      ` + await readFile(file, 'utf8'))
    }
    const executablePath = real && process.env.ZALO_CHROME_PATH
    const profile = path.join(temp, 'profile')
    if (executablePath) {
      stock = await launchStockChrome(executablePath, profile, extension)
      context = stock.context
    } else {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        ignoreDefaultArgs: real ? ['--disable-component-update', '--disable-background-networking'] : [],
        args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
      })
    }
    const page = await context.newPage()
    await page.setViewportSize({ width: 1040, height: 610 })
    await page.route('https://chat.zalo.me/', route => route.fulfill({ path: path.join(__dirname, 'fixture.html') }))
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto('https://chat.zalo.me/')
    const select = page.getByLabel('Язык ответа')
    const editor = page.locator('#richInput')
    const direct = page.locator('.zru-send')
    const native = page.locator('#nativeSend')
    const sent = page.locator('#sent')
    const status = page.locator('.zru-status')
    await select.waitFor()
    assert.equal(await select.inputValue(), 'vi')
    assert.equal(await page.locator('.zru-bar button').count(), 1)
    assert.equal(await direct.evaluate(node => node.closest('.zru-bar')?.nextElementSibling?.id), 'chatInput')
    assert.equal(await page.locator('#normal-buttons-group-id > *').count(), 1)
    assert.equal(await direct.isDisabled(), true)
    const inbound = page.locator('.chat-message').first()
    if (real) {
      const download = inbound.getByRole('button', { name: 'Перевести', exact: true })
      await Promise.race([download.waitFor({timeout: 10000}).catch(() => {}),
        inbound.locator('.zru-result').waitFor({timeout: 10000}).catch(() => {})])
      if (await download.isVisible()) await download.click()
      const failure = inbound.getByRole('button', { name: 'Через Google' })
      await Promise.race([failure.waitFor({timeout: 90000}), inbound.locator('.zru-result').waitFor({timeout: 90000})])
      if (await failure.isVisible()) throw new Error(await inbound.locator('.zru-translation').innerText())
    }
    await inbound.locator('.zru-result').waitFor({ timeout: 90000 })
    assert.match(await inbound.locator('.zru-result').innerText(), /[А-Яа-яЁё]/)
    assert.equal(await page.locator('.chat-message.me .zru-translation').count(), 0)

    // A mounted but invisible Zalo dialog must not cancel an otherwise valid send.
    await page.evaluate(() => {
      const modal = document.createElement('div')
      modal.className = 'zl-modal'
      modal.style.visibility = 'hidden'
      modal.textContent = 'Скрытый диалог'
      document.body.append(modal)
    })
    await editor.fill('Привет! Отправьте, пожалуйста, адрес.')
    await direct.click()
    await page.waitForFunction(() => document.querySelector('#sent').dataset.count === '1', null, { timeout: 90000 })
    assert.match(await sent.innerText(), /Chào/i)
    assert.equal(await editor.innerText(), '')
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: path.join(evidence, real ? 'chrome-translation.png' : 'desktop.png') })
    await select.selectOption('en')
    await editor.fill('Привет! Отправьте, пожалуйста, адрес.')
    await direct.click()
    await page.waitForFunction(() => document.querySelector('#sent').dataset.count === '2', null, { timeout: 90000 })
    assert.match(await sent.innerText(), /Hello/i)
    assert.equal(await editor.innerText(), '')

    if (!real) {
      await editor.fill('СОВПАДЕНИЕ')
      await direct.click()
      await page.getByText('Перевод совпал с оригиналом.').waitFor()
      assert.equal(await sent.getAttribute('data-count'), '2')

      await editor.fill('Привет!')
      await page.locator('.zl-modal').evaluate(node => { node.style.visibility = 'visible' })
      await direct.click()
      await page.getByText('Закройте открытое окно Zalo').waitFor()
      assert.equal(await sent.getAttribute('data-count'), '2')
      await page.locator('.zl-modal').evaluate(node => node.remove())

      await editor.fill('Привет!')
      await direct.evaluate(node => node.click())
      assert.equal(await sent.getAttribute('data-count'), '2')
      await direct.click()
      await editor.fill('Новый черновик')
      await page.getByText('Отправка отменена.').waitFor()
      assert.equal(await editor.innerText(), 'Новый черновик')
      assert.equal(await sent.getAttribute('data-count'), '2')

      await editor.fill('Привет!')
      await page.locator('html').evaluate(node => { delete node.dataset.lastTranslated })
      await direct.click()
      await page.locator('.conv-item.selected').evaluate(node => { node.dataset.id = 'away-chat' })
      await page.waitForFunction(() => !document.querySelector('.zru-send').disabled)
      await page.locator('.conv-item.selected').evaluate(node => { node.dataset.id = 'sample-chat' })
      await page.waitForFunction(() => document.documentElement.dataset.lastTranslated === 'Привет!')
      assert.equal(await editor.innerText(), 'Привет!')
      assert.equal(await sent.getAttribute('data-count'), '2')

      await native.evaluate(node => { node.disabled = true })
      await direct.click()
      await page.getByText('Передаём перевод в Zalo', { exact: false }).waitFor()
      await select.selectOption('vi')
      await page.waitForFunction(() => document.querySelector('#richInput').innerText === 'Привет!')
      assert.equal(await sent.getAttribute('data-count'), '2')
      await direct.click()
      await page.getByText('Кнопка отправки Zalo недоступна.', { exact: false }).waitFor()
      assert.equal(await editor.innerText(), 'Привет!')
      assert.equal(await sent.getAttribute('data-count'), '2')
      await native.evaluate(node => { node.disabled = false })

      await sent.evaluate(node => { node.dataset.keepDraft = 'yes' })
      await direct.click()
      await page.waitForFunction(() => document.querySelector('#sent').dataset.count === '3')
      await direct.click()
      await page.getByText('Команда уже передана Zalo.', { exact: false }).waitFor()
      assert.equal(await sent.getAttribute('data-count'), '3')
      await sent.evaluate(node => { delete node.dataset.keepDraft })

      await editor.fill('ОШИБКА')
      await direct.click()
      await page.getByText('Тестовая ошибка.').waitFor()
      assert.equal(await editor.innerText(), 'ОШИБКА')
      assert.equal(await sent.getAttribute('data-count'), '3')

      await page.reload()
      await select.waitFor()
      await page.locator('body').evaluate(node => { node.dataset.localUnsupported = 'true' })
      await editor.fill('Привет через браузер')
      await direct.click()
      const google = page.getByRole('button', {name: 'Отправить через Google'})
      await google.waitFor()
      assert.equal(await page.locator('.zru-bar button').count(), 1)
      await google.evaluate(node => node.click())
      assert.equal(await page.locator('html').getAttribute('data-cloud-requests'), null)
      await editor.fill('Другой текст')
      await google.waitFor({ state: 'hidden' })
      await direct.click()
      await google.click()
      await page.getByText('Облачный перевод настраивается в меню расширения.').waitFor()
      assert.equal(await page.locator('html').getAttribute('data-cloud-requests'), '1')
      assert.equal(await editor.innerText(), 'Другой текст')
      await page.locator('body').evaluate(node => { delete node.dataset.localUnsupported })

      await select.selectOption('off')
      await direct.waitFor({ state: 'hidden' })
      await editor.fill('Оригинал')
      await native.click()
      assert.equal(await sent.innerText(), 'Оригинал')
      await page.getByLabel('Входящие на русском').uncheck()
      await inbound.locator('.zru-result').waitFor({ state: 'hidden' })
      await page.reload()
      await select.waitFor()
      assert.equal(await select.inputValue(), 'off')
      assert.equal(await page.getByLabel('Входящие на русском').isChecked(), false)
      await page.getByLabel('Входящие на русском').check()
      await inbound.locator('.zru-result').waitFor()
      await select.selectOption('vi')
      await direct.waitFor()
      await page.setViewportSize({ width: 360, height: 640 })
      await editor.fill('Привет!')
      const composerClicks = page.locator('#chat-box-input-container-id')
      const before = await composerClicks.getAttribute('data-clicks')
      await page.locator('.zru-bar').click({ position: { x: 2, y: 2 } })
      assert.equal(await editor.evaluate(node => document.activeElement === node), true)
      assert.equal(await composerClicks.getAttribute('data-clicks'), before)
      await direct.click()
      await status.getByText('Переводим ответ…').waitFor()
      await page.screenshot({ path: path.join(evidence, 'narrow.png') })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.waitForFunction(() => document.querySelector('#sent').dataset.count === '1')
      await page.setViewportSize({ width: 1040, height: 610 })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: path.join(evidence, 'dark.png') })
    }
    assert.deepEqual(pageErrors, [])
    console.log(real ? 'PASS Chrome models: VI→RU, RU→VI, RU→EN' :
      'PASS incoming, VI, EN, original, restore, stale draft, offline/API errors, untrusted clicks, chat switching, reused message, persistence and 360 px')
  } catch (error) {
    await mkdir(evidence, { recursive: true })
    await context?.pages().at(-1)?.screenshot({ path: path.join(evidence, real ? 'chrome-error.png' : 'error.png') }).catch(() => {})
    throw error
  } finally {
    if (stock) {
      await new Promise(resolve => {
        if (stock.process.exitCode !== null || stock.process.signalCode !== null) return resolve()
        stock.process.once('exit', resolve)
        stock.process.kill()
      })
    } else await context?.close()
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

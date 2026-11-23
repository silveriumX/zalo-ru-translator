const input = document.querySelector('#cloudKey')
const status = document.querySelector('#status')
const origin = 'https://translation.googleapis.com/*'

async function refresh() {
  const { cloudKey } = await chrome.storage.local.get('cloudKey')
  status.textContent = cloudKey ? 'Ключ сохранён в этом браузере.' : ''
}
refresh()

document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault()
  const key = input.value.trim()
  if (!key) {
    status.textContent = 'Введите ключ Google Cloud Translation.'
    return
  }
  try {
    if (!(await chrome.permissions.request({ origins: [origin] }))) {
      status.textContent = 'Доступ к Google Cloud не выдан.'
      return
    }
    await chrome.storage.local.set({ cloudKey: key })
    input.value = ''
    await refresh()
  } catch {
    status.textContent = 'Ключ не удалось сохранить.'
  }
})

document.querySelector('#clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('cloudKey')
  await chrome.permissions.remove({ origins: [origin] })
  input.value = ''
  status.textContent = 'Ключ удалён.'
})

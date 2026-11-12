/**
 * 可控浏览器底座：启动/复用带远程调试端口的 Edge（或 Chrome），用 CDP 驱动页面。
 *
 * 设计要点：
 * - 只用 Node 内置模块 + 全局 fetch/WebSocket，不引入任何 npm 依赖。
 * - 浏览器用独立 --user-data-dir，Cookie 持久化；窗口可见，验证码留给用户手动完成。
 * - ensureStarted 幂等：先探 127.0.0.1:<port>/json/version，通了就复用（reused:true）。
 * - Page 每个命令 30 秒超时；点击/输入都在页面里用原生 setter + 事件，兼容 React。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { browserDir, ensureDir, messageOf, shotsDir } from './util.mjs'

const DEFAULT_PORT = 9233
const COMMAND_TIMEOUT = 30_000
const START_TIMEOUT = 20_000
const DEFAULT_WAIT_MS = 2_500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 从 PATH 里找可执行文件（Linux/macOS 用）。 */
function findInPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch { /* ignore */ }
    }
  }
  return ''
}

/** 浏览器可执行文件候选顺序：Edge → Chrome；按当前系统给出常见安装位置。 */
export function browserCandidates() {
  const home = os.homedir()
  const platform = process.platform
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    return [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean)
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter(Boolean)
  }
  return [
    findInPath(['microsoft-edge', 'microsoft-edge-stable']),
    findInPath(['google-chrome', 'google-chrome-stable']),
    findInPath(['chromium', 'chromium-browser']),
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
}

/** 找浏览器：设置里的路径优先，其次按系统常见位置找 Edge，再 Chrome，都没有就报中文错。 */
export function findBrowser(exePath) {
  const given = String(exePath ?? '').trim()
  if (given) {
    if (!fs.existsSync(given)) throw new Error(`设置里填写的浏览器路径不存在：${given}`)
    return given
  }
  for (const candidate of browserCandidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('没找到 Edge 或 Chrome：请先安装，或到「设置 → 详细参数 → 浏览器路径」里填写完整路径')
}

/** 网络抓包过滤器：子串优先，也允许写正则。 */
function matchUrl(url, pattern) {
  const value = String(url ?? '')
  if (!pattern) return true
  if (value.includes(pattern)) return true
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

export class Browser {
  constructor(opts = {}) {
    this._port = Number(opts.port) > 0 ? Math.floor(Number(opts.port)) : DEFAULT_PORT
    this.appId = String(opts.appId ?? 'ZJU-mooc-assistant')
    this.dataDir = String(opts.dataDir ?? '').trim() || browserDir()
    this.browserPath = String(opts.browserPath ?? '').trim()
    // 无头模式：登录/滑块要用户看得见，所以只有「已登录后的后台执行」才用它
    this.headless = opts.headless === true
    this._log = typeof opts.log === 'function' ? opts.log : () => {}
    this._started = false
    this._owned = false // 是否由本实例启动（复用别人的实例时不动）
    this._exe = ''
    this._startedAt = null
    this._proc = null
    this._pages = new Map() // 标签页 id → Page，避免重复连同一个页面
  }

  /** 是否由本实例启动（复用别人的实例时不动）。 */
  get owned() {
    return this._owned
  }

  get port() {
    return this._port
  }

  /** 是否已经确认浏览器可用（ensureStarted 成功后为 true）。 */
  get started() {
    return this._started
  }

  get exe() {
    return this._exe
  }

  get startedAt() {
    return this._startedAt
  }

  get base() {
    return `http://127.0.0.1:${this._port}`
  }

  _logLine(...args) {
    try {
      this._log(...args)
    } catch {
      /* 日志回调自己出错不影响主流程 */
    }
  }

  async _httpJson(route, init = {}, timeoutMs = 5_000) {
    const res = await fetch(this.base + route, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`浏览器调试接口返回 HTTP ${res.status}：${route}`)
    return res.json()
  }

  /** 探调试端口是否已经可用。 */
  async _probe() {
    try {
      await this._httpJson('/json/version', {}, 3_000)
      return true
    } catch {
      return false
    }
  }

  async _waitPort(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this._probe()) return true
      await sleep(300)
    }
    return false
  }

  _guessExe() {
    try {
      return findBrowser(this.browserPath)
    } catch {
      return ''
    }
  }

  /** 启动（或复用）浏览器调试实例；幂等。 */
  async ensureStarted() {
    if (this._started && (await this._probe())) {
      return { port: this._port, reused: !this._owned, exe: this._exe || this._guessExe() }
    }
    // 端口上已经有浏览器在跑：直接复用，绝不杀别人的进程
    if (await this._probe()) {
      this._started = true
      this._owned = false
      this._exe = this._exe || this._guessExe()
      this._logLine('检测到已在运行的浏览器调试端口，直接复用', this._port)
      return { port: this._port, reused: true, exe: this._exe }
    }

    const exe = findBrowser(this.browserPath)
    this._exe = exe
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this._launch(exe)
      if (await this._waitPort(START_TIMEOUT)) {
        this._started = true
        this._owned = true
        this._startedAt = new Date().toISOString()
        this._logLine('已启动浏览器', exe, `调试端口 ${this._port}`)
        return { port: this._port, reused: false, exe }
      }
      this._logLine(`浏览器调试端口 20 秒内没有就绪，重试第 ${attempt} 次`)
    }
    throw new Error(`浏览器启动后 20 秒内没有打开调试端口 ${this._port}：可能被安全软件拦截，或者另一个使用同一浏览器数据目录的 Edge 还开着（关掉它，或在设置里换一个浏览器端口）`)
  }

  _launch(exe) {
    ensureDir(this.dataDir)
    const args = [
      `--remote-debugging-port=${this._port}`,
      `--user-data-dir=${this.dataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,900',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
    ]
    if (this.headless) {
      // 后台执行：不弹出可见窗口。用新版 headless，保留完整渲染/视频解码能力；
      // 允许无手势自动播放，否则静音/非静音的 <video>.play() 会被拦。
      args.push('--headless=new', '--mute-audio', '--disable-gpu', '--autoplay-policy=no-user-gesture-required')
    }
    args.push('about:blank')
    const proc = spawn(exe, args, { detached: true, stdio: 'ignore' })
    proc.on('error', error => this._logLine('启动浏览器失败：', messageOf(error)))
    proc.unref()
    this._proc = proc
  }

  /** 列出所有标签页（type=page）。 */
  async listPages() {
    let list
    try {
      list = await this._httpJson('/json/list')
    } catch (error) {
      throw new Error(`连不上浏览器调试端口 ${this._port}：${messageOf(error)}`)
    }
    if (!Array.isArray(list)) throw new Error('浏览器调试接口返回的标签页列表格式不对')
    return list
      .filter(item => (item.type ?? 'page') === 'page')
      .map(item => ({
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        ws: String(item.webSocketDebuggerUrl ?? ''),
      }))
  }

  /** 同一个标签页只建一个 Page，复用 WebSocket 连接。 */
  _page(target) {
    const id = String(target.id ?? '')
    if (!id) throw new Error('浏览器没有返回标签页 id')
    let page = this._pages.get(id)
    if (page) return page
    page = new Page(this, {
      id,
      title: target.title ?? '',
      url: target.url ?? '',
      ws: target.webSocketDebuggerUrl ?? target.ws ?? '',
    })
    this._pages.set(id, page)
    return page
  }

  /** 找地址里包含 urlPart 的标签页复用；没有就新建 about:blank。 */
  async pageFor(urlPart = 'icourse163.org') {
    const part = String(urlPart ?? '')
    const pages = await this.listPages()
    const found = part ? pages.find(item => item.url.includes(part)) : pages[0]
    if (found) return this._page({ ...found, webSocketDebuggerUrl: found.ws })
    return this.newPage('about:blank')
  }

  /** 新建标签页。新版本 Chrome/Edge 要求 /json/new 用 PUT。 */
  async newPage(url = 'about:blank') {
    const address = String(url ?? 'about:blank') || 'about:blank'
    let info
    try {
      info = await this._httpJson(`/json/new?${encodeURIComponent(address)}`, { method: 'PUT' }, 10_000)
    } catch (error) {
      throw new Error(`新建标签页失败：${messageOf(error)}`)
    }
    if (!info || !info.id) throw new Error('新建标签页失败：浏览器没有返回标签页信息')
    const page = this._page({
      id: info.id,
      title: info.title ?? '',
      url: info.url ?? address,
      webSocketDebuggerUrl: info.webSocketDebuggerUrl ?? '',
    })
    return page
  }

  /** 打开 icourse163 页面并导航到 url（默认复用 icourse163 标签页）。 */
  async open(url) {
    await this.ensureStarted()
    const page = await this.pageFor('icourse163.org')
    if (url && url !== 'about:blank') await page.goto(url)
    await this.bringToFront().catch(() => {})
    return page
  }

  /** 把 icourse163 标签页（没有就第一个）拉到前台。 */
  async bringToFront() {
    const pages = await this.listPages()
    const target = pages.find(item => item.url.includes('icourse163.org')) || pages[0]
    if (!target) return
    try {
      await fetch(`${this.base}/json/activate/${target.id}`, { signal: AbortSignal.timeout(5_000) })
    } catch {
      /* 激活失败不影响后续操作 */
    }
  }

  /** 不管是不是自己启动的，都通过 CDP 关掉浏览器（切可见窗口时用，会正常刷盘 Cookie）。 */
  async shutdown() {
    for (const page of this._pages.values()) page._dispose()
    this._pages.clear()
    this._started = false
    try {
      const version = await this._httpJson('/json/version')
      const ws = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接浏览器调试通道超时')), 5_000)
        timer.unref?.()
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器调试通道失败')) }, { once: true })
      })
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await sleep(300)
      try { ws.close() } catch { /* ignore */ }
    } catch (error) {
      this._logLine('用 CDP 关闭浏览器失败：', messageOf(error))
    }
    await this._waitGone(5_000)
    this._owned = false
    this._startedAt = null
    this._logLine('浏览器已关闭（切换可见窗口）')
  }

  /** 关掉自己启动的浏览器；复用别人的实例时不动。 */
  async stop() {
    for (const page of this._pages.values()) page._dispose()
    this._pages.clear()
    this._started = false
    if (!this._owned) {
      this._logLine('浏览器不是本实例启动的，停止时不动它')
      return
    }
    this._owned = false
    try {
      const version = await this._httpJson('/json/version')
      const ws = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接浏览器调试通道超时')), 5_000)
        timer.unref?.()
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器调试通道失败')) }, { once: true })
      })
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await sleep(300)
      try { ws.close() } catch { /* ignore */ }
    } catch (error) {
      this._logLine('用 CDP 关闭浏览器失败，改为结束进程：', messageOf(error))
    }
    if (!(await this._waitGone(5_000)) && this._proc?.pid) {
      try { process.kill(this._proc.pid) } catch { /* ignore */ }
    }
    this._startedAt = null
    this._logLine('浏览器已关闭')
  }

  async _waitGone(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this._probe())) return true
      await sleep(300)
    }
    return false
  }
}

/** 页面里点击元素：滚动到可见区、检查可见性、再 click（会冒泡到 React 监听）。 */
const CLICK_FN = `function (selector) {
  const el = document.querySelector(selector)
  if (!el) return { ok: false, reason: 'not-found' }
  const rect = el.getBoundingClientRect()
  const style = window.getComputedStyle(el)
  const invisible = (rect.width === 0 && rect.height === 0) || style.visibility === 'hidden' || style.display === 'none'
  if (invisible) return { ok: false, reason: 'invisible' }
  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) {}
  try { el.focus({ preventScroll: true }) } catch (error) {}
  try { el.click() } catch (error) { return { ok: false, reason: 'error', message: String((error && error.message) || error) } }
  return { ok: true }
}`

/** 页面里按文字找可点元素：先精确匹配，再包含匹配；多个命中取文字最短（最具体）的那个。 */
const CLICK_TEXT_FN = `function (text, within) {
  const root = within ? document.querySelector(within) : document.body
  if (!root) return { ok: false, reason: 'no-root' }
  const nodes = Array.from(root.querySelectorAll('a,button,[role=button],li,label,span,div,p,td,th,input[type=submit]'))
  const isVisible = node => {
    const rect = node.getBoundingClientRect()
    const style = window.getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const contentOf = node => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim()
  const candidates = []
  for (const node of nodes) {
    if (!isVisible(node)) continue
    const content = contentOf(node)
    if (!content) continue
    const exact = content === text
    if (!exact && !content.includes(text)) continue
    candidates.push({ node, content, exact })
  }
  if (!candidates.length) return { ok: false, reason: 'not-found' }
  candidates.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (a.content.length - b.content.length))
  const chosen = candidates[0]
  try { chosen.node.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) {}
  try { chosen.node.click() } catch (error) { return { ok: false, reason: 'error', message: String((error && error.message) || error) } }
  return { ok: true, content: chosen.content }
}`

/** 页面里填输入框：原生 value setter + input/change 事件，React 受控组件也能收到。 */
const TYPE_FN = `function (selector, value) {
  const el = document.querySelector(selector)
  if (!el) return { ok: false, reason: 'not-found' }
  try { el.focus({ preventScroll: true }) } catch (error) {}
  const prototype = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor && descriptor.set) descriptor.set.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}`

export class Page {
  constructor(browser, target = {}) {
    this._browser = browser
    this.id = String(target.id ?? '')
    this._wsUrl = String(target.ws ?? target.webSocketDebuggerUrl ?? '')
    this._ws = null
    this._opening = null
    this._nextId = 0
    this._pending = new Map()
    this._network = []
    this._bodies = new Map()
    this._networkOn = false
  }

  get port() {
    return this._browser.port
  }

  get wsUrl() {
    return this._wsUrl
  }

  _logLine(...args) {
    this._browser._logLine(...args)
  }

  /** 确保调试通道已连接；浏览器重启过就重新解析 WebSocket 地址再连一次。 */
  async _ensure() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return
    if (this._opening) {
      await this._opening
      return
    }
    this._opening = (async () => {
      try {
        await this._open()
      } catch (first) {
        this._wsUrl = ''
        try {
          await this._resolveWs()
          await this._open()
        } catch {
          throw first
        }
      }
    })()
    try {
      await this._opening
    } finally {
      this._opening = null
    }
  }

  async _resolveWs() {
    const pages = await this._browser.listPages()
    const previous = this.id
    const target = pages.find(item => item.id === this.id) || pages[0]
    if (!target) throw new Error('当前浏览器没有可用的标签页')
    // 浏览器重启过的话标签页 id 会变，跟着换成新 id
    this.id = target.id || this.id
    if (previous && this.id && previous !== this.id) {
      this._browser._pages.delete(previous)
      this._browser._pages.set(this.id, this)
    }
    this._wsUrl = target.ws
  }

  async _open() {
    if (!this._wsUrl) await this._resolveWs()
    if (!this._wsUrl) throw new Error('标签页没有调试通道地址')
    if (this._ws) {
      try { this._ws.close() } catch { /* ignore */ }
      this._ws = null
    }
    const ws = new WebSocket(this._wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接浏览器调试通道超时')), 10_000)
      timer.unref?.()
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器调试通道失败')) }, { once: true })
    })
    ws.addEventListener('message', event => this._onMessage(event.data))
    ws.addEventListener('close', () => this._onClose())
    ws.addEventListener('error', () => { /* 错误由 close 统一处理 */ })
    this._ws = ws
    // 页面级事件：加载、导航、执行上下文、网络（抓包 lazily 再开）
    await this._send('Page.enable')
    await this._send('Runtime.enable')
  }

  _onMessage(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id) {
      const pending = this._pending.get(message.id)
      if (!pending) return
      this._pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`浏览器命令 ${pending.method} 失败：${message.error.message || '未知错误'}`))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    this._onEvent(message)
  }

  _onClose() {
    this._ws = null
    for (const [id, pending] of this._pending) {
      this._pending.delete(id)
      pending.reject(new Error('浏览器调试通道已断开'))
    }
  }

  _onEvent(message) {
    if (message.method === 'Network.responseReceived') {
      const params = message.params || {}
      const response = params.response || {}
      this._network.push({
        requestId: String(params.requestId ?? ''),
        url: String(response.url ?? ''),
        status: Number(response.status ?? 0),
        type: String(params.type ?? ''),
        mimeType: String(response.mimeType ?? ''),
        at: Date.now(),
      })
      if (this._network.length > 600) this._network.splice(0, this._network.length - 600)
    }
  }

  /** 发一条 CDP 命令；每个命令默认 30 秒超时。 */
  _send(method, params = {}, timeoutMs = COMMAND_TIMEOUT) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('浏览器调试通道没有连接'))
    }
    const id = ++this._nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`浏览器命令超时（${Math.round(timeoutMs / 1000)} 秒）：${method}`))
      }, timeoutMs)
      timer.unref?.()
      this._pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        this._ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(new Error(`发送浏览器命令失败：${messageOf(error)}`))
      }
    })
  }

  /** 把这个标签页切到前台（新版中国大学 MOOC 可见才加载数据）。 */
  async activate() {
    await this._ensure()
    try {
      await this._send('Page.bringToFront')
      return true
    } catch {
      return false
    }
  }

  /** 发一条原始 CDP 命令（需要 Input 域、Target 域等高级能力时用）。 */
  async send(method, params = {}, timeoutMs) {
    await this._ensure()
    return this._send(method, params, timeoutMs || COMMAND_TIMEOUT)
  }

  /** 当前页面归属的 Browser 实例（找弹窗标签页时用）。 */
  get browser() {
    return this._browser
  }

  /** 用真实鼠标事件点击元素：window.open / 登录弹窗 / 需要用户手势的场景必须用它。 */
  async realClick(selector, opts = {}) {
    const selectorJson = JSON.stringify(String(selector))
    const rect = await this.eval(`(() => {
      const el = document.querySelector(${selectorJson})
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
    })()`)
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      const current = await this.url().catch(() => '')
      throw new Error(`要点击的元素不可见：${selector}${current ? `（当前地址 ${current}）` : ''}`)
    }
    return this.realClickAt(rect.x, rect.y, opts)
  }

  /** 在页面坐标上按真实鼠标事件点击。 */
  async realClickAt(x, y, opts = {}) {
    const point = { x: Math.round(Number(x)), y: Math.round(Number(y)) }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' })
    await new Promise(resolve => setTimeout(resolve, Number(opts.hoverMs) || 60))
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, Number(opts.holdMs) || 80))
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    return point
  }

  /** 找到包含指定文本的可点击元素（返回 CSS 选择器，配合 realClick/click 用）。 */
  async findTextSelector(text, opts = {}) {
    const label = String(text ?? '')
    const tag = opts.tag ? String(opts.tag) : ''
    return this.eval(`(() => {
      const wanted = ${JSON.stringify(label)}
      const tag = ${JSON.stringify(tag)}
      const nodes = [...document.querySelectorAll(tag || 'a,span,div,button,li')]
      const hit = nodes.find(n => {
        if (n.offsetParent === null) return false
        const value = (n.textContent || '').trim()
        if (!value || value.length > 40) return false
        const matched = ${opts.exact === true ? 'value === wanted' : 'value.includes(wanted)'} 
        if (!matched) return false
        if (tag) return true
        // 取最内层可点节点：子元素里还有同样文本就跳过
        const inner = [...n.querySelectorAll('*')].some(child => (child.textContent || '').trim() === value && child.offsetParent !== null)
        return !inner
      })
      if (!hit) return null
      if (hit.id) return '#' + CSS.escape(hit.id)
      const cls = String(hit.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3)
      if (cls.length) {
        const candidate = hit.tagName.toLowerCase() + '.' + cls.map(c => CSS.escape(c)).join('.')
        if (document.querySelectorAll(candidate).length === 1) return candidate
        const withText = candidate + ':not(:has(*))'
        const byText = [...document.querySelectorAll(candidate)].find(n => !n.children.length && (n.textContent||'').trim() === (hit.textContent||'').trim())
        if (byText) return candidate
      }
      const path = []
      let node = hit
      while (node && node.nodeType === 1 && path.length < 6) {
        let parent = node.parentElement
        if (!parent) break
        const index = [...parent.children].indexOf(node) + 1
        path.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')')
        node = parent
      }
      return path.join(' > ')
    })()`)
  }

  async eval(expr, opts = {}) {
    await this._ensure()
    const result = await this._send('Runtime.evaluate', {
      expression: String(expr),
      returnByValue: true,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    }, opts.timeoutMs || COMMAND_TIMEOUT)
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      const detail = details.exception?.description || details.text || '脚本执行出错'
      throw new Error(`页面脚本执行出错：${String(detail).split('\n')[0]}`)
    }
    const value = result.result ? result.result.value : undefined
    return value === undefined ? null : value
  }

  /** 把参数 JSON 序列化后调用页面里的函数表达式。 */
  async _call(fnSource, ...args) {
    const params = args.map(arg => JSON.stringify(arg)).join(', ')
    return this.eval(`(${fnSource})(${params})`)
  }

  /** 导航到地址，等页面加载完成（优先 readyState === 'complete'）。 */
  async goto(url, opts = {}) {
    await this._ensure()
    const address = String(url ?? '').trim()
    if (!address) throw new Error('导航失败：地址为空')
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : COMMAND_TIMEOUT
    const result = await this._send('Page.navigate', { url: address }, timeoutMs)
    if (result.errorText) throw new Error(`打开页面失败：${result.errorText}（${address}）`)
    await this._waitLoad(opts)
  }

  async _waitLoad(opts) {
    const waitMs = Number.isFinite(Number(opts.waitMs)) ? Math.max(0, Number(opts.waitMs)) : DEFAULT_WAIT_MS
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : COMMAND_TIMEOUT
    const deadline = Date.now() + Math.min(waitMs, timeoutMs)
    while (Date.now() < deadline) {
      const ready = await this.eval("document.readyState === 'complete'").catch(() => false)
      if (ready) break
      await sleep(200)
    }
    // 给首屏脚本、懒加载留一点时间
    await sleep(Math.min(1_200, Math.max(300, Math.round(waitMs / 4))))
    if (opts.waitForExpr) await this.waitFor(opts.waitForExpr, { timeoutMs })
  }

  /** 轮询页面条件，超时抛中文错误。 */
  async waitFor(expr, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15_000
    const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 300
    const label = opts.label || String(expr)
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await this.eval(`(() => { try { return !!(${String(expr)}) } catch (error) { return false } })()`)
        if (value) return true
      } catch (error) {
        lastError = error
      }
      await sleep(intervalMs)
    }
    const current = await this.url().catch(() => '')
    const suffix = current ? `（当前地址 ${current}）` : ''
    const cause = lastError ? `；最后一次错误：${messageOf(lastError)}` : ''
    throw new Error(`等待页面条件超时：${label}${suffix}${cause}`)
  }

  async waitForSelector(selector, opts = {}) {
    return this.waitFor(`document.querySelector(${JSON.stringify(String(selector))})`, {
      label: `选择器 ${selector}`,
      ...opts,
    })
  }

  async waitForUrl(fragment, opts = {}) {
    return this.waitFor(`location.href.includes(${JSON.stringify(String(fragment))})`, {
      label: `地址包含 ${fragment}`,
      ...opts,
    })
  }

  /** 点击元素；找不到或不可见就抛中文错误（附当前地址）。 */
  async click(selector) {
    await this._ensure()
    const target = String(selector ?? '')
    const result = await this._call(CLICK_FN, target)
    if (result?.ok) return
    const current = await this.url().catch(() => '')
    const suffix = current ? `，当前地址 ${current}` : ''
    if (result?.reason === 'invisible') throw new Error(`点击失败：元素不可见（${target}）${suffix}`)
    if (result?.reason === 'error') throw new Error(`点击失败：${result.message || '页面报错'}（${target}）${suffix}`)
    throw new Error(`点击失败：页面上找不到元素（${target}）${suffix}`)
  }

  /** 按文字点击；先精确匹配再包含匹配，超时返回 false。 */
  async clickText(text, opts = {}) {
    await this._ensure()
    const wanted = String(text ?? '')
    if (!wanted) throw new Error('按文字点击失败：文字为空')
    const within = opts.within ? String(opts.within) : ''
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this._call(CLICK_TEXT_FN, wanted, within)
      if (result?.ok) return true
      if (result?.reason === 'no-root') throw new Error(`按文字点击失败：找不到范围选择器 ${within}`)
      if (result?.reason === 'error') throw new Error(`按文字点击失败：${result.message || '页面报错'}（${wanted}）`)
      await sleep(300)
    }
    return false
  }

  /** 填输入框：原生 setter + input/change，兼容 React 受控组件。 */
  async type(selector, text) {
    await this._ensure()
    const target = String(selector ?? '')
    const result = await this._call(TYPE_FN, target, String(text ?? ''))
    if (result?.ok) return
    const current = await this.url().catch(() => '')
    const suffix = current ? `，当前地址 ${current}` : ''
    throw new Error(`输入失败：页面上找不到输入框（${target}）${suffix}`)
  }

  async text() {
    const value = await this.eval("document.body ? document.body.innerText : ''")
    return typeof value === 'string' ? value : ''
  }

  async html(limit = 200_000) {
    const value = await this.eval('document.documentElement ? document.documentElement.outerHTML : ""')
    const text = typeof value === 'string' ? value : ''
    const max = Number(limit) > 0 ? Number(limit) : 200_000
    return text.length > max ? text.slice(0, max) : text
  }

  async url() {
    const value = await this.eval('location.href')
    return typeof value === 'string' ? value : ''
  }

  async title() {
    const value = await this.eval('document.title')
    return typeof value === 'string' ? value : ''
  }

  /** 截图到指定文件，返回绝对路径。 */
  async screenshot(file) {
    await this._ensure()
    const given = String(file ?? '').trim()
    const absolute = given
      ? (path.isAbsolute(given) ? given : path.resolve(process.cwd(), given))
      : path.join(shotsDir(), `page-${Date.now()}.png`)
    ensureDir(path.dirname(absolute))
    const result = await this._send('Page.captureScreenshot', { format: 'png' })
    if (!result?.data) throw new Error('截图失败：浏览器没有返回图片数据')
    fs.writeFileSync(absolute, Buffer.from(result.data, 'base64'))
    return absolute
  }

  async _readCookies(method) {
    const result = await this._send(method, {})
    return Array.isArray(result?.cookies) ? result.cookies : []
  }

  /**
   * 读 Cookie。给定 domainPart 时用浏览器级 Storage.getCookies 取全量再过滤
   * （Network.getCookies 只看当前页面的 URL，在 about:blank 上会拿不到 icourse163 的 Cookie）。
   */
  async cookies(domainPart) {
    await this._ensure()
    const part = String(domainPart ?? '')
    let all
    if (part) {
      all = await this._readCookies('Storage.getCookies').catch(() => this._readCookies('Network.getCookies'))
    } else {
      all = await this._readCookies('Network.getCookies').catch(() => this._readCookies('Storage.getCookies'))
    }
    return all
      .filter(cookie => !part || String(cookie.domain || '').includes(part) || String(cookie.url || '').includes(part))
      .map(cookie => ({ name: String(cookie.name ?? ''), value: String(cookie.value ?? ''), domain: String(cookie.domain ?? '') }))
  }

  async cookieValue(name, domainPart) {
    const wanted = String(name ?? '')
    if (!wanted) return null
    const list = await this.cookies(domainPart)
    const found = list.find(cookie => cookie.name === wanted)
    return found ? found.value : null
  }

  async setUserAgent(ua) {
    await this._ensure()
    await this._send('Network.setUserAgentOverride', { userAgent: String(ua ?? '') })
  }

  /** 关闭当前标签页。 */
  async close() {
    const id = this.id
    this._dispose()
    if (!id) return
    try {
      await fetch(`${this._browser.base}/json/close/${id}`, { signal: AbortSignal.timeout(5_000) })
    } catch {
      /* 标签页可能已经不在了 */
    }
    this._browser._pages.delete(id)
  }

  _dispose() {
    if (this._ws) {
      try { this._ws.close() } catch { /* ignore */ }
      this._ws = null
    }
    for (const [id, pending] of this._pending) {
      this._pending.delete(id)
      pending.reject(new Error('页面已关闭'))
    }
  }

  // ---- 网络抓包：mooc 提取器失败时用来 dump JSON 接口 ----

  async startNetwork() {
    await this._ensure()
    await this._send('Network.enable', {
      maxTotalBufferSize: 20 * 1024 * 1024,
      maxResourceBufferSize: 5 * 1024 * 1024,
    })
    this._network = []
    this._bodies.clear()
    this._networkOn = true
    return true
  }

  async takeNetwork(opts = {}) {
    await this._ensure()
    let list = this._network.slice()
    const since = Number(opts.since)
    if (Number.isFinite(since) && since > 0) list = list.filter(item => item.at >= since)
    const filter = String(opts.filter ?? '').trim()
    if (filter) list = list.filter(item => matchUrl(item.url, filter))
    const output = []
    for (const item of list) {
      const entry = { url: item.url, status: item.status, type: item.type }
      if (/json|javascript|text|xml|form/i.test(item.mimeType)) {
        const body = await this._networkBody(item).catch(() => '')
        if (body) entry.body = body.slice(0, 200_000)
      }
      output.push(entry)
    }
    return output
  }

  async _networkBody(item) {
    const requestId = String(item?.requestId ?? '')
    if (!requestId) return ''
    if (this._bodies.has(requestId)) return this._bodies.get(requestId)
    const result = await this._send('Network.getResponseBody', { requestId })
    const body = result?.base64Encoded
      ? Buffer.from(String(result.body ?? ''), 'base64').toString('utf8')
      : String(result?.body ?? '')
    this._bodies.set(requestId, body)
    return body
  }

  async stopNetwork() {
    if (!this._networkOn && !this._ws) return
    this._networkOn = false
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    try {
      await this._send('Network.disable')
    } catch {
      /* 页面可能已经关了 */
    }
  }
}

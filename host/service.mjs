/**
 * ZJU-mooc-assistant host 服务：
 * - 保存设置 / 账号 / 课程 / 大纲 / 任务状态（都在 $DSH_HOME/ZJU-mooc-assistant 下）
 * - 管理一个可调试的 Edge/Chrome 窗口，负责登录、课程刷新、大纲刷新
 * - 串行执行任务队列（同一时间只跑一个网页任务），把进度实时写回状态供页面轮询
 * - 通过 connection.fetch 暴露 /api/mooc-companion
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Browser, findBrowser } from './cdp.mjs'
import * as mooc from './mooc.mjs'
import { answerQuizWithModel, summarizeLesson, writeDiscussionQuestion } from './brain.mjs'
import { runTask } from './exec.mjs'
import {
  APP_ID, browserDir, cleanString, dataRoot, ensureDir, isoOrNull, messageOf, nowIso,
  percent, readJson, SETTINGS_VERSION, shotsDir, truncate, writeJson,
} from './util.mjs'

const STATE_VERSION = 1
// 可分发副本的版本标记：写进 runtime.json / snapshot，安装后能确认加载的是哪一份
const PLUGIN_VERSION = '0.2.1'
const CATEGORY_URL = 'https://www.icourse163.org/category/all'
const LOG_LIMIT = 200
const TASK_LOG_LIMIT = 60

export const DEFAULT_SETTINGS = {
  nickname: '',
  videoSpeed: 2,
  videoMuted: false,
  autoDiscussAfterVideo: true,
  quizRepairSecondAttempt: true,
  examAttempts: 1,
  quizFillStrategy: 'model+knowledge',
  reasoningEffort: 'medium',
  browserPort: 9233,
  browserPath: '',
  maxJobs: 40,
  autoRefreshCourses: false,
  // 后台执行：登录后任务在无头浏览器里跑，不弹窗口；登录/滑块时仍会打开可见窗口
  backgroundExecution: true,
}

const EFFORTS = new Set(['', 'low', 'medium', 'high', 'max'])
const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('任务已取消')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(new Error('任务已取消')) }, { once: true })
  })
}

function emptyLogin() {
  return { status: 'unknown', needUser: null, message: '', user: null, at: null }
}

function jobView(job) {
  return {
    id: job.id,
    taskId: job.taskId ?? null,
    taskTitle: job.taskTitle || '',
    status: job.status,
    percent: percent(job.percent),
    phase: job.phase || '',
    message: job.message || '',
    startedAt: job.startedAt || nowIso(),
    finishedAt: job.finishedAt || null,
    error: job.error || null,
  }
}

/**
 * 把「第一节 / 第12节 / 第十二周 / 第3章」里的序数转成数字。
 * 新版站点接口/标题混用阿拉伯数字和中文数字，排序必须按真实序数，不能按字符串。
 */
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function chineseToNumber(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let current = 0
  for (const char of text) {
    if (char === '十') { total += (current || 1) * 10; current = 0 }
    else if (char === '百') { total += (current || 1) * 100; current = 0 }
    else if (char in CN_DIGITS) current = CN_DIGITS[char]
    else return null
  }
  return total + current || null
}

/** 章节序数：优先解析「第X周/章/讲/单元」里的数字，解析不到用兜底值。 */
function chapterOrdinal(title, fallback) {
  const text = String(title ?? '')
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : 1
  const matched = text.match(/第\s*([一二三四五六七八九十百零两\d]+)\s*(?:周|章|讲|单元|部分)/)
  if (matched) {
    const number = chineseToNumber(matched[1])
    if (number) return number
  }
  // 「考试 / 测验与作业」这类没有序数的板块统一排在所有周后面
  if (/考试/.test(text)) return 9000 + fallbackNumber
  if (/测验与作业|作业/.test(text)) return 8000 + fallbackNumber
  return fallbackNumber
}

/** 小节序数：从「第二节」「第十二节」「3. xxx」里取数字，取不到返回 null。 */
function sectionOrdinal(title) {
  const text = String(title ?? '')
  const matched = text.match(/第\s*([一二三四五六七八九十百零两\d]+)\s*节/)
  if (matched) {
    const number = chineseToNumber(matched[1])
    if (number) return number
  }
  const arabic = text.match(/^\s*(\d+)\s*[.、:：)]/)
  if (arabic) return Number(arabic[1])
  return null
}

/** 把大纲的章节按真实序数排好（有的学期接口会返回「第15周」在「第14周」前面）。 */
function sortOutlineChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((chapter, index) => ({ chapter, index, ordinal: chapterOrdinal(chapter?.title, index + 1) }))
    .sort((a, b) => a.ordinal - b.ordinal || a.index - b.index)
    .map(({ chapter }, index) => ({ ...chapter, index: index + 1 }))
}

/** 从任务里挑出「刷新大纲/课程时不能丢」的用户状态。 */
function preservedTaskFields(task) {  return {
    status: task.status,
    plannedAt: task.plannedAt ?? null,
    autoRun: task.autoRun === true,
    attempts: task.attempts || 0,
    score: typeof task.score === 'number' ? task.score : null,
    maxScore: typeof task.maxScore === 'number' ? task.maxScore : null,
    progress: task.progress || { percent: 0, phase: '', message: '', updatedAt: null },
    log: Array.isArray(task.log) ? task.log : [],
    detail: task.detail || '',
    createdAt: task.createdAt || nowIso(),
    updatedAt: task.updatedAt || nowIso(),
  }
}

/**
 * 按「每天 8:00–24:00」生成 count 个随机的完成时间：
 * - 时间严格递增，最后一个不晚于 deadline；都在允许的时间窗内；
 * - 用于「设置计划截止时间后，把该任务及之前未完成的任务按顺序自动完成」。
 */
export function planCompletionTimes(count, startMs, deadlineMs) {
  const total = Math.max(0, Math.floor(Number(count) || 0))
  if (!total) return []
  if (!Number.isFinite(startMs) || !Number.isFinite(deadlineMs) || deadlineMs <= startMs) {
    throw new Error('截止时间要晚于现在。')
  }
  const DAY = 24 * 60 * 60 * 1000
  const dayStart = new Date(startMs)
  dayStart.setHours(0, 0, 0, 0)
  const windows = []
  for (let day = dayStart.getTime(); day <= deadlineMs; day += DAY) {
    const open = new Date(day)
    open.setHours(8, 0, 0, 0)
    const close = new Date(day)
    close.setHours(24, 0, 0, 0)
    const from = Math.max(startMs, open.getTime())
    const to = Math.min(deadlineMs, close.getTime())
    if (to - from >= 60_000) windows.push([from, to])
  }
  const available = windows.reduce((sum, [from, to]) => sum + (to - from), 0)
  if (available < total * 60_000) {
    throw new Error('截止时间离现在太近了，安排不下这么多任务；把截止时间往后调，或者先完成一部分任务。')
  }
  const gap = Math.min(5 * 60_000, Math.max(60_000, Math.floor(available / (total * 6))))
  const usable = Math.max(total * 60_000, available - gap * (total - 1))
  const toTimestamp = offset => {
    let remain = Math.min(Math.max(offset, 0), available - 1)
    for (const [from, to] of windows) {
      if (remain <= to - from) return from + remain
      remain -= to - from
    }
    return windows[windows.length - 1][1]
  }
  const times = []
  for (let index = 0; index < total; index += 1) {
    const sliceStart = (usable * index) / total
    const sliceEnd = Math.max(sliceStart, (usable * (index + 1)) / total - gap)
    const offset = sliceStart + Math.random() * (sliceEnd - sliceStart) + index * gap
    times.push(toTimestamp(offset))
  }
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] <= times[index - 1]) times[index] = times[index - 1] + 60_000
  }
  if (times[times.length - 1] > deadlineMs) times[times.length - 1] = deadlineMs
  return times
}

export class MoocCompanion {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config && typeof config === 'object' ? config : {}
    this.root = dataRoot()
    this.settingsFile = path.join(this.root, 'settings.json')
    this.accountFile = path.join(this.root, 'account.json')
    this.stateFile = path.join(this.root, 'state.json')

    this.settings = this.loadSettings()
    this.account = this.loadAccount()
    this.state = this.loadState()

    this.browser = null
    this.page = null
    this.ensuredHeadless = false
    this.browserInfo = {
      running: false,
      port: Number(this.settings.browserPort) || 9233,
      url: '',
      title: '',
      startedAt: null,
    }
    this.queue = []
    this.current = null
    this.currentAbort = null
    this.pumping = false
    this.loginWatcher = null
    this.timer = null
    this.lastPersist = 0
    this.apiDispose = undefined
    this.disposed = false
  }

  // ---------- 设置 / 账号 / 状态 ----------

  loadSettings() {
    const stored = readJson(this.settingsFile, {})
    const merged = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
    merged.nickname = cleanString(merged.nickname, 40)
    merged.videoSpeed = Math.min(4, Math.max(1, Number(merged.videoSpeed) || 2))
    merged.videoMuted = merged.videoMuted === true
    merged.autoDiscussAfterVideo = merged.autoDiscussAfterVideo !== false
    merged.quizRepairSecondAttempt = merged.quizRepairSecondAttempt !== false
    merged.examAttempts = Math.min(3, Math.max(1, Number(merged.examAttempts) || 1))
    merged.quizFillStrategy = ['model', 'model+knowledge'].includes(merged.quizFillStrategy) ? merged.quizFillStrategy : 'model+knowledge'
    if (!EFFORTS.has(merged.reasoningEffort)) merged.reasoningEffort = 'medium'
    merged.browserPort = Math.min(65000, Math.max(1024, Number(merged.browserPort) || 9233))
    merged.browserPath = cleanString(merged.browserPath, 600)
    merged.maxJobs = Math.min(200, Math.max(10, Number(merged.maxJobs) || 40))
    merged.autoRefreshCourses = merged.autoRefreshCourses === true
    merged.backgroundExecution = merged.backgroundExecution !== false
    delete merged.selectedCourses
    return merged
  }

  loadAccount() {
    const stored = readJson(this.accountFile, {})
    const email = cleanString(stored?.email, 200)
    const password = typeof stored?.password === 'string' ? stored.password : ''
    return {
      email,
      password: stored?.remember === false ? '' : password,
      remember: stored?.remember !== false,
      savedAt: cleanString(stored?.savedAt, 40) || null,
    }
  }

  loadState() {
    const stored = readJson(this.stateFile, {})
    const state = {
      version: STATE_VERSION,
      courses: Array.isArray(stored?.courses) ? stored.courses : [],
      outlineByCourse: stored?.outlineByCourse && typeof stored.outlineByCourse === 'object' ? stored.outlineByCourse : {},
      tasks: Array.isArray(stored?.tasks) ? stored.tasks.filter(task => task && typeof task.id === 'string') : [],
      lessonNotes: stored?.lessonNotes && typeof stored.lessonNotes === 'object' ? stored.lessonNotes : {},
      selectedCourseId: cleanString(stored?.selectedCourseId, 80) || null,
      jobs: Array.isArray(stored?.jobs) ? stored.jobs.filter(job => job && typeof job.id === 'string') : [],
      login: stored?.login && typeof stored.login === 'object' ? { ...emptyLogin(), ...stored.login } : emptyLogin(),
      log: Array.isArray(stored?.log) ? stored.log.slice(-LOG_LIMIT) : [],
      browser: stored?.browser && typeof stored.browser === 'object' ? stored.browser : { startedAt: null, url: '', title: '' },
      lastCoursesAt: cleanString(stored?.lastCoursesAt, 40) || null,
    }
    let interrupted = false
    for (const task of state.tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'failed'
        task.detail = '插件重启时这个任务被中断了，可以点重试。'
        task.progress = { percent: 0, phase: '已中断', message: task.detail, updatedAt: nowIso() }
        task.updatedAt = nowIso()
        interrupted = true
      }
    }
    for (const job of state.jobs) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'cancelled'
        job.phase = '已中断'
        job.finishedAt = nowIso()
        interrupted = true
      }
    }
    this.state = state
    if (interrupted) this.saveState(true)
    return state
  }

  saveSettings() {
    writeJson(this.settingsFile, { ...this.settings, version: SETTINGS_VERSION, updatedAt: nowIso() })
  }

  saveAccount() {
    if (!this.account.email) {
      try { fs.rmSync(this.accountFile, { force: true }) } catch { /* ignore */ }
      return
    }
    writeJson(this.accountFile, {
      email: this.account.email,
      password: this.account.remember ? this.account.password : '',
      remember: this.account.remember,
      savedAt: this.account.savedAt,
    })
  }

  saveState(force = false) {
    if (!force && Date.now() - this.lastPersist < 800) return
    this.lastPersist = Date.now()
    const maxJobs = Math.max(10, Number(this.settings.maxJobs) || 40)
    if (this.state.jobs.length > maxJobs) this.state.jobs = this.state.jobs.slice(0, maxJobs)
    writeJson(this.stateFile, this.state)
  }

  accountView() {
    return {
      email: this.account.email,
      hasPassword: !!this.account.password,
      remember: this.account.remember,
      savedAt: this.account.savedAt,
    }
  }

  loginView() {
    return { ...emptyLogin(), ...(this.state.login || {}) }
  }

  log(text, level = 'info') {
    const entry = { at: nowIso(), level, text: truncate(String(text ?? ''), 1200, '…') }
    this.state.log.push(entry)
    if (this.state.log.length > LOG_LIMIT) this.state.log = this.state.log.slice(-LOG_LIMIT)
    try {
      const line = `[ZJU-mooc-assistant] ${entry.text}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch { /* ignore */ }
  }

  appendTaskLog(task, text) {
    if (!task || !text) return
    if (!Array.isArray(task.log)) task.log = []
    task.log.push({ at: nowIso(), text: truncate(String(text), 600, '…') })
    if (task.log.length > TASK_LOG_LIMIT) task.log = task.log.slice(-TASK_LOG_LIMIT)
    task.updatedAt = nowIso()
  }

  // ---------- 生命周期 ----------

  start() {
    ensureDir(this.root)
    ensureDir(shotsDir())
    this.registerApi().catch(error => this.log(`API 注册失败：${messageOf(error)}`, 'error'))
    this.timer = setInterval(() => { this.refreshBrowserInfo().catch(() => {}) }, 6000)
    this.timer.unref?.()
    // 计划截止时间：到点的任务自动按顺序进执行队列（每 20 秒检查一次）
    this.schedulerTimer = setInterval(() => { void this.pumpScheduled() }, 20_000)
    this.schedulerTimer.unref?.()
    // 没有任务时，后台浏览器不应该继续播放视频（否则 Edge 的系统媒体控件会一直亮着）
    this.playbackTimer = setInterval(() => { void this.stopBackgroundPlayback() }, 8_000)
    this.playbackTimer.unref?.()
    this.log('ZJU-mooc-assistant已启动')
    // 上一次插件重启时如果还停在「等待滑块/验证」，那只是内存里的轮询；开机时不能假装还在等。
    if (this.state.login?.status === 'pending') {
      this.state.login = {
        status: 'unknown',
        needUser: null,
        message: '上次的登录等待被中断了，需要的话再点一次「登录」。',
        user: null,
        at: nowIso(),
      }
    }
    // 启动标记：既方便用户排查「插件到底加载没有」，也是集成验证的凭据。
    try {
      writeJson(path.join(this.root, 'runtime.json'), {
        version: 1,
        pluginVersion: PLUGIN_VERSION,
        appId: APP_ID,
        startedAt: nowIso(),
        pid: process.pid,
        port: Number(this.settings.browserPort) || 9233,
      }, 0o600)
    } catch { /* ignore */ }
    this.saveState(true)
    // 首次启动自动检查环境：缺浏览器/模型时在页面上直接提示，而不是等执行任务才报错
    this.environment = { status: 'checking', ok: null, checks: [], checkedAt: null }
    setTimeout(() => { void this.runEnvironmentCheck() }, 300).unref?.()
    // 旧版本大纲没有讨论要求信息：启动后自动刷一次，把不需要的讨论任务清掉
    if (this.config.autoMigrate !== false) setTimeout(() => { void this.migrateDiscussionTasks() }, 4_000).unref?.()
    return () => this.dispose()
  }

  /** 启动时/设置变更后检查运行环境，不启动浏览器、不联网。 */
  async runEnvironmentCheck() {
    const checks = []
    // 数据目录
    try {
      ensureDir(this.root)
      const probe = path.join(this.root, '.write-check')
      fs.writeFileSync(probe, 'ok', { mode: 0o600 })
      const value = fs.readFileSync(probe, 'utf8')
      fs.rmSync(probe, { force: true })
      if (value !== 'ok') throw new Error('写入后读回不一致')
      checks.push({ key: 'data', ok: true, message: `数据目录可用：${this.root}` })
    } catch (error) {
      checks.push({ key: 'data', ok: false, message: `数据目录不可写：${messageOf(error)}` })
    }
    // 浏览器
    try {
      const exe = findBrowser(this.settings.browserPath)
      checks.push({ key: 'browser', ok: true, message: `浏览器可用：${exe}` })
    } catch (error) {
      checks.push({ key: 'browser', ok: false, message: messageOf(error) })
    }
    // DSH 默认模型
    try {
      const llm = this.ctx?.get?.('llm')
      const selection = this.ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
      const ready = Boolean(llm && typeof llm.stream === 'function' && selection?.provider && selection?.model)
      checks.push({
        key: 'model',
        ok: ready,
        message: ready
          ? `默认模型已配置：${selection.provider} / ${selection.model}`
          : 'DSH 还没有选择默认模型：自动答题、讨论和课堂要点都会失败，请先到 DSH 设置里选一个模型。',
      })
    } catch (error) {
      checks.push({ key: 'model', ok: false, message: `模型服务不可用：${messageOf(error)}` })
    }
    // 调试端口只做提示，不算失败
    const port = Number(this.settings.browserPort) || 9233
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) })
      checks.push({ key: 'port', ok: true, message: `调试端口 ${port} 上已有浏览器实例，将直接复用` })
    } catch {
      checks.push({ key: 'port', ok: true, message: `调试端口 ${port} 当前空闲，任务开始时会自动启动浏览器` })
    }
    this.environment = {
      status: 'ready',
      ok: checks.every(check => check.ok),
      checks,
      checkedAt: nowIso(),
    }
  }

  /**
   * 暂停当前页面里的音视频。
   * 默认只在「没有当前任务、队列为空」时执行；任务结束的收尾会 force=true 再清一次。
   */
  async stopBackgroundPlayback({ force = false } = {}) {
    if (!force && (this.current || this.queue.length)) return 0
    if (!this.page) return 0
    const alive = await this.page.eval('1').then(() => true).catch(() => false)
    if (!alive) { this.page = null; return 0 }
    try {
      const paused = await mooc.pauseVideoPlayback(this.page)
      if (paused > 0) this.log(`已暂停后台视频播放（${paused} 个）`)
      return paused
    } catch { return 0 }
  }

  outlineNeedsDiscussionRefresh(outline) {
    if (!outline || !Array.isArray(outline.chapters)) return false
    // 旧版大纲没有讨论标记版本：强制重读一次，把「课件」页里的讨论单元补进来
    if (Number(outline.discussionFlagVersion) < 3) return true
    const videos = outline.chapters.flatMap(chapter => (chapter.units || []).filter(unit => unit.kind === 'video'))
    if (!videos.length) return false
    return !videos.some(unit => Object.prototype.hasOwnProperty.call(unit, 'hasDiscussion'))
  }

  async migrateDiscussionTasks() {
    if (this.disposed) return
    const selected = this.state.selectedCourseId
    const outline = selected ? this.state.outlineByCourse[selected] : null
    if (!outline || !this.outlineNeedsDiscussionRefresh(outline)) return
    if (this.state.login?.status !== 'logged-in') return
    if (this.current || this.queue.length) return
    this.log('旧大纲缺少讨论要求，自动刷新章节大纲并清理不需要的讨论任务')
    this.enqueueJob({
      type: 'outline',
      taskId: null,
      title: '刷新章节大纲（清理讨论任务）',
      run: job => this.runRefreshOutline(job, { courseId: selected }),
    })
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    this.schedulerTimer = undefined
    if (this.playbackTimer) clearInterval(this.playbackTimer)
    this.playbackTimer = undefined
    try { this.currentAbort?.abort() } catch { /* ignore */ }
    try { this.loginWatcher?.abort() } catch { /* ignore */ }
    if (typeof this.apiDispose === 'function') { try { this.apiDispose() } catch { /* ignore */ } }
    this.saveState(true)
  }

  async registerApi() {
    const connection = this.ctx.get?.('connection')
    if (!connection?.fetch?.register) {
      this.log('当前 profile 没有 connection.fetch 服务，页面接口不可用', 'warn')
      return
    }
    this.apiDispose = await connection.fetch.register({
      path: '/api/mooc-companion',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => this.handleRequest(request),
    })
  }

  async handleRequest(request) {
    let body
    try { body = await request.json() } catch { return this.json({ error: '请求格式不正确' }, 400) }
    const action = typeof body?.action === 'string' ? body.action : ''
    const input = body?.input && typeof body.input === 'object' ? body.input : {}
    try {
      const value = await this.action(action, input)
      return this.json({ value })
    } catch (error) {
      this.log(`操作 ${action} 失败：${messageOf(error)}`, 'warn')
      return this.json({ error: messageOf(error) }, 400)
    }
  }

  json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  async action(action, input) {
    switch (action) {
      case 'bootstrap':
      case 'status':
        await this.refreshBrowserInfo().catch(() => {})
        return this.snapshot()
      case 'saveAccount': return this.saveAccountFromUi(input)
      case 'login': return this.actionLogin(input)
      case 'checkLogin': return this.actionCheckLogin()
      case 'logout': return this.actionLogout()
      case 'openBrowser': return this.actionOpenBrowser(input)
      case 'openPage': return this.actionOpenPage(input)
      case 'openTaskPage': return this.actionOpenTaskPage(input)
      case 'refreshCourses': return this.actionRefreshCourses(input)
      case 'selectCourse': return this.actionSelectCourse(input)
      case 'refreshOutline': return this.actionRefreshOutline(input)
      case 'runTask': return this.actionRunTask(input)
      case 'cancelTask': return this.actionCancelTask(input)
      case 'planTask': return this.actionPlanTask(input)
      case 'scheduleDeadline': return this.actionScheduleDeadline(input)
      case 'setSetting': return this.actionSetSetting(input)
      case 'saveSettings': return this.actionSaveSettings(input)
      case 'diagnostics': return this.actionDiagnostics(input)
      case 'clearLog': return this.actionClearLog()
      default: throw new Error(`未知操作：${action}`)
    }
  }

  // ---------- 浏览器 ----------

  async refreshBrowserInfo() {
    const port = Number(this.settings.browserPort) || 9233
    const info = this.browserInfo
    info.port = port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error('not ready')
      info.running = true
      if (!info.startedAt) info.startedAt = nowIso()
      if (this.page) {
        try { info.url = await this.page.url() } catch { /* ignore */ }
        try { info.title = await this.page.title() } catch { /* ignore */ }
      }
    } catch {
      info.running = false
    }
  }

  /**
   * 拿到受控浏览器页面。
   * opts.forceVisible：登录/手动打开时用——必须有可见窗口，用户才能滑验证码；
   * 普通任务在已登录且开启「后台执行」时用无头浏览器，不弹窗口、不抢焦点。
   */
  async ensurePage(options = {}) {
    const port = Number(this.settings.browserPort) || 9233
    const forceVisible = options?.forceVisible === true
    const loggedIn = this.state.login?.status === 'logged-in'
    const desiredHeadless = this.settings.backgroundExecution === true && loggedIn && !forceVisible
    if (this.browser && this.browser.headless !== desiredHeadless) {
      // 窗口模式和无头模式不能共用同一个调试端口，需要先关掉自己启动的那个
      if (this.browser.owned) {
        this.log(desiredHeadless ? '切换到后台执行（隐藏浏览器窗口）' : '切换到可见浏览器窗口')
        try { await this.browser.stop() } catch { /* ignore */ }
        this.browser = null
        this.page = null
        this.browserInfo.running = false
      } else {
        this.log('当前浏览器是外部实例，忽略后台/窗口模式切换', 'warn')
      }
    }
    if (!this.browser) {
      this.browser = new Browser({
        port,
        appId: APP_ID,
        dataDir: browserDir(),
        browserPath: cleanString(this.settings.browserPath, 600),
        headless: desiredHeadless,
        log: (...args) => this.log(args.join(' ')),
      })
      this.ensuredHeadless = desiredHeadless
      this.page = null
    }
    const started = await this.browser.ensureStarted()
    this.ensuredHeadless = this.browser.headless
    this.browserInfo.running = true
    this.browserInfo.port = port
    if (!this.browserInfo.startedAt) this.browserInfo.startedAt = nowIso()
    if (started?.exe && !this.browserInfo.exe) this.browserInfo.exe = started.exe
    if (!this.page) {
      this.page = await this.browser.pageFor('icourse163.org')
    }
    // 标签页可能被用户/外部操作关掉：先确认还能执行脚本，不能就重新拿一个
    if (this.page) {
      const alive = await this.page.eval('1').then(() => true).catch(() => false)
      if (!alive) {
        this.page = null
        this.page = await this.browser.pageFor('icourse163.org')
      }
    }
    // 新开的标签页是 about:blank：先落到中国大学 MOOC，登录态判断和页面读取才有上下文
    const currentUrl = String(await this.page.url().catch(() => '') || '')
    if (!/icourse163\.org/.test(currentUrl)) {
      try { await this.page.goto('https://www.icourse163.org/', { waitMs: 2_500 }) } catch { /* ignore */ }
    }
    // 新版中国大学 MOOC 是「可见才加载」：每次拿页面都把这个标签页切到前台。
    try { await this.page.activate?.() } catch { /* ignore */ }
    if (!this.ensuredHeadless) {
      try { await this.browser.bringToFront?.() } catch { /* ignore */ }
    }
    return this.page
  }

  /** 拿页面失败时重试一次（用户可能把窗口关了）。 */
  async acquirePage(options = {}) {
    try {
      return await this.ensurePage(options)
    } catch (error) {
      this.page = null
      try {
        return await this.ensurePage(options)
      } catch {
        throw new Error(`打不开受控浏览器：${messageOf(error)}`)
      }
    }
  }

  // ---------- 登录 ----------

  applyLoginState(result) {
    const loggedIn = result?.loggedIn === true
    const issue = loggedIn ? null : (result?.needUser || null)
    this.state.login = {
      status: loggedIn ? 'logged-in' : (result?.status === 'failed' ? 'failed' : 'unknown'),
      needUser: issue,
      message: cleanString(result?.message, 400) || (loggedIn ? '已登录' : ''),
      user: result?.user && typeof result.user === 'object'
        ? { name: cleanString(result.user.name, 80), email: cleanString(result.user.email, 200) }
        : null,
      at: nowIso(),
    }
    this.saveState(true)
  }

  async afterLogin() {
    this.log('登录成功')
    const selected = this.state.selectedCourseId
    const hasCourses = Array.isArray(this.state.courses) && this.state.courses.length > 0
    if (!hasCourses && !this.current) {
      this.enqueueJob({ type: 'courses', taskId: null, taskTitle: '刷新课程', title: '刷新课程', run: job => this.runRefreshCourses(job, {}) })
    } else if (selected && !this.state.outlineByCourse[selected] && !this.current) {
      this.enqueueJob({ type: 'outline', taskId: null, taskTitle: '刷新章节大纲', title: '刷新章节大纲', run: job => this.runRefreshOutline(job, { courseId: selected }) })
    } else if (selected && this.state.outlineByCourse[selected] && this.outlineNeedsDiscussionRefresh(this.state.outlineByCourse[selected]) && !this.current) {
      void this.migrateDiscussionTasks()
    }
    // 登录完成后如果开了「后台执行」，把可见窗口收掉，后面的任务在后台跑
    if (this.settings.backgroundExecution && !this.ensuredHeadless) {
      setTimeout(() => { this.switchToBackground().catch(() => {}) }, 2_000).unref?.()
    }
  }

  /** 把可见窗口换成无头实例；有任务正在跑时不打断它。 */
  async switchToBackground() {
    if (!this.settings.backgroundExecution || this.ensuredHeadless) return
    if (!this.browser?.owned) return
    if (this.current || this.queue.length) return
    this.log('登录完成，关闭可见浏览器窗口，之后在后台执行')
    try { await this.browser.stop() } catch { /* ignore */ }
    this.browser = null
    this.page = null
    this.ensuredHeadless = false
    this.browserInfo.running = false
    this.saveState(true)
  }

  async actionLogin(input) {
    const force = input?.force !== false
    if (!force) return this.actionCheckLogin()
    if (!this.account.email || !this.account.password) {
      throw new Error('还没有保存账号和密码，请先在「账号与登录」里填写并保存。')
    }
    const page = await this.acquirePage({ forceVisible: true })
    try { this.loginWatcher?.abort() } catch { /* ignore */ }
    const watcher = new AbortController()
    this.loginWatcher = watcher
    this.state.login = { status: 'pending', needUser: null, message: '正在打开中国大学 MOOC 登录页…', user: null, at: nowIso() }
    this.saveState(true)
    this.runLogin(page, watcher.signal).catch(error => {
      if (watcher.signal.aborted) return
      this.state.login = { status: 'failed', needUser: null, message: messageOf(error), user: null, at: nowIso() }
      this.saveState(true)
      this.log(`登录失败：${messageOf(error)}`, 'error')
    })
    return { login: this.loginView() }
  }

  async runLogin(page, signal) {
    await mooc.openLogin(page, { categoryFirst: false })
    if (signal.aborted) return
    this.state.login = { status: 'pending', needUser: null, message: '正在填写账号…', user: null, at: nowIso() }
    const filled = await mooc.fillLogin(page, { email: this.account.email, password: this.account.password })
    if (signal.aborted) return
    if (filled?.needSubmit !== false) {
      this.state.login = { status: 'pending', needUser: null, message: '已填好账号，正在提交登录…', user: null, at: nowIso() }
      await mooc.submitLogin(page)
    }
    const deadline = Date.now() + 150_000
    let lastMessage = ''
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(2200, signal)
      let result
      try {
        result = await mooc.checkLogin(page)
      } catch (error) {
        this.log(`检查登录状态出错：${messageOf(error)}`, 'warn')
        continue
      }
      if (result?.loggedIn) {
        this.applyLoginState(result)
        await this.afterLogin()
        return
      }
      const issue = result?.needUser || null
      const message = issue === 'captcha'
        ? '需要完成滑块/验证码：请在弹出的浏览器窗口里手动滑一下，完成后我会自动继续。'
        : issue === 'verify'
          ? '需要手机/邮箱验证：请在浏览器窗口里完成验证。'
          : (result?.message || '正在等待登录…')
      this.state.login = { status: 'pending', needUser: issue, message, user: result?.user || null, at: nowIso() }
      if (message !== lastMessage) { lastMessage = message; this.saveState() }
    }
    if (signal.aborted) return
    throw new Error('等了 2 分半还没登录成功。请在浏览器窗口里完成验证后，再点「检查登录」。')
  }

  async actionCheckLogin() {
    const page = await this.acquirePage({ forceVisible: this.state.login?.status !== 'logged-in' })
    const result = await mooc.checkLogin(page)
    this.applyLoginState(result)
    if (result?.loggedIn) await this.afterLogin()
    return { login: this.loginView() }
  }

  async actionLogout() {
    this.state.login = {
      status: 'unknown',
      needUser: null,
      message: '已标记为未登录。如果要退出账号，请在浏览器窗口右上角点「退出」。',
      user: null,
      at: nowIso(),
    }
    this.saveState(true)
    return { login: this.loginView() }
  }

  async actionOpenBrowser(input) {
    const page = await this.acquirePage({ forceVisible: true })
    const target = cleanString(input?.url, 500) || CATEGORY_URL
    const current = await page.url().catch(() => '')
    if (current !== target) {
      this.log(`打开页面：${target}`)
      await page.goto(target, { waitMs: 2200 })
    }
    await this.refreshBrowserInfo().catch(() => {})
    return { browser: this.browserView(), login: this.loginView() }
  }

  async actionOpenPage(input) {
    const url = cleanString(input?.url, 500)
    if (!/^https?:\/\//i.test(url)) throw new Error('要打开的地址不对')
    const page = await this.acquirePage({ forceVisible: true })
    this.log(`手动打开：${url}`)
    await page.goto(url, { waitMs: 2200 })
    await this.refreshBrowserInfo().catch(() => {})
    return { browser: this.browserView(), login: this.loginView() }
  }

  /** 手动打开页面必须让人看见窗口：把后台无头实例换成可见实例。 */
  async ensureVisibleBrowser() {
    if (this.current || this.queue.length) return false
    const port = Number(this.settings.browserPort) || 9233
    const options = {
      port,
      appId: APP_ID,
      dataDir: browserDir(),
      browserPath: cleanString(this.settings.browserPath, 600),
      headless: false,
      log: (...args) => this.log(args.join(' ')),
    }
    if (this.browser) {
      if (this.ensuredHeadless || !this.browser.owned) {
        this.log('打开页面：切换到可见浏览器窗口')
        if (this.browser.owned) await this.browser.stop().catch(() => {})
        else await this.browser.shutdown().catch(() => {})
        this.browser = null
        this.page = null
        this.browserInfo.running = false
        this.ensuredHeadless = false
      }
      return true
    }
    // 重新加载插件后 this.browser 可能为空，但端口上还挂着一个后台无头实例
    const probe = new Browser(options)
    try {
      const started = await probe.ensureStarted()
      if (started?.reused) {
        this.log('打开页面：检测到后台浏览器，先关闭再启动可见窗口')
        await probe.shutdown().catch(() => {})
      } else {
        this.browser = probe
        this.ensuredHeadless = false
      }
    } catch (error) {
      await probe.shutdown().catch(() => {})
      this.log('打开页面：可见浏览器启动失败，继续用现有浏览器', 'warn')
    }
    return true
  }

  async actionOpenTaskPage(input) {
    const taskId = cleanString(input?.taskId, 160)
    const task = this.state.tasks.find(entry => entry.id === taskId)
    if (!task) throw new Error('任务不存在，先刷新页面再试。')
    this.log(`打开任务页面：${task.title}`)
    await this.ensureVisibleBrowser().catch(() => {})
    const page = await this.acquirePage({ forceVisible: true })
    const unit = {
      id: task.unitId,
      title: task.title,
      kind: task.kind,
      url: task.url || '',
      ...(task.unit || {}),
    }
    try {
      await mooc.enterUnit(page, unit)
    } catch (error) {
      const fallback = cleanString(task.url, 500) || cleanString(task.unit?.learnUrl, 500) || cleanString(task.courseUrl, 500)
      if (!fallback) throw error
      await page.goto(fallback, { waitMs: 2_200 })
    }
    await this.refreshBrowserInfo().catch(() => {})
    return { browser: this.browserView(), login: this.loginView() }
  }

  browserView() {
    return {
      running: !!this.browserInfo.running,
      headless: this.ensuredHeadless === true,
      port: Number(this.settings.browserPort) || 9233,
      url: this.browserInfo.url || '',
      title: this.browserInfo.title || '',
      startedAt: this.browserInfo.startedAt || null,
    }
  }

  // ---------- 账号 ----------

  async saveAccountFromUi(input) {
    const email = cleanString(input?.email, 200)
    const password = typeof input?.password === 'string' ? input.password : ''
    const remember = input?.remember !== false
    if (!email) throw new Error('请先填写中国大学 MOOC 的账号（手机号或邮箱）。')
    const hasPassword = password.length > 0
    const keepOld = !hasPassword && this.account.password && this.account.email === email
    if (remember && !hasPassword && !keepOld) throw new Error('勾选了「记住密码」就要把密码一起填上。')
    this.account = {
      email,
      password: remember ? (hasPassword ? password : this.account.password) : '',
      remember,
      savedAt: nowIso(),
    }
    this.saveAccount()
    this.log(`已保存账号 ${email}`)
    this.saveState(true)
    return { account: this.accountView() }
  }

  // ---------- 课程 / 大纲 ----------

  async requireLoggedIn(page) {
    const result = await mooc.checkLogin(page)
    this.applyLoginState(result)
    if (result?.loggedIn) return result
    if (result?.needUser) throw new Error('登录还没完成：请先在浏览器窗口里完成验证码/验证，再点「检查登录」。')
    throw new Error('还没有登录中国大学 MOOC。先点「登录」，在弹出窗口里登录后再刷新。')
  }

  async actionRefreshCourses(input) {
    if (this.current && this.current.job.type === 'courses') throw new Error('课程正在刷新，稍等一下。')
    const job = this.enqueueJob({
      type: 'courses',
      taskId: null,
      title: '刷新课程',
      run: (jobRef, signal) => this.runRefreshCourses(jobRef, input, signal),
    })
    return { job: jobView(job) }
  }

  async runRefreshCourses(job, input = {}, signal) {
    const page = await this.acquirePage()
    job.phase = '检查登录'
    job.percent = 10
    await this.requireLoggedIn(page)
    if (signal?.aborted) throw new Error('任务已取消')
    job.phase = '读取我的课程'
    job.percent = 35
    const onlySpoc = input?.onlySpoc === true
    const courses = await mooc.readMyCourses(page, { onlySpoc })
    if (!Array.isArray(courses) || !courses.length) {
      throw new Error('没有读到课程。可能登录失效了，或者「我的课程」页面结构变了；可以点「打开中国大学 MOOC」看看。')
    }
    this.state.courses = courses.map(course => ({
      id: cleanString(course.id, 80),
      title: cleanString(course.title, 200) || '未命名课程',
      teacher: cleanString(course.teacher, 120),
      term: cleanString(course.term, 80),
      cover: cleanString(course.cover, 600),
      url: cleanString(course.url, 600),
      spoc: course.spoc === true,
      state: cleanString(course.state, 80),
      progress: Number.isFinite(course.progress) ? Math.max(0, Math.min(1, course.progress)) : null,
      school: cleanString(course.school, 120),
      // 站点内部标识：读大纲 / 讨论区 / 老站 data-cid 都要用，不能在这层丢掉
      shortName: cleanString(course.shortName, 120),
      termId: cleanString(course.termId, 40),
      sourceTermId: cleanString(course.sourceTermId, 40),
      courseId: cleanString(course.courseId, 40),
      site: cleanString(course.site, 20),
    })).filter(course => course.id)
    this.state.lastCoursesAt = nowIso()
    const currentSelected = this.state.selectedCourseId
    if (!currentSelected || !this.state.courses.some(course => course.id === currentSelected)) {
      const preferred = this.state.courses.find(course => course.spoc) || this.state.courses[0]
      this.state.selectedCourseId = preferred?.id || null
    }
    job.phase = '整理课程'
    job.percent = 80
    this.saveState(true)
    job.message = `读到 ${this.state.courses.length} 门课程`
    this.log(`刷新课程成功：${this.state.courses.length} 门`)
    const selected = this.state.selectedCourseId
    if (selected && !this.state.outlineByCourse[selected]) {
      this.enqueueJob({
        type: 'outline',
        taskId: null,
        title: '刷新章节大纲',
        run: (jobRef, innerSignal) => this.runRefreshOutline(jobRef, { courseId: selected }, innerSignal),
      })
    }
    return { message: job.message }
  }

  async actionSelectCourse(input) {
    const courseId = cleanString(input?.courseId, 80)
    const course = this.state.courses.find(item => item.id === courseId)
    if (!course) throw new Error('没有这门课程，先刷新课程列表。')
    this.state.selectedCourseId = courseId
    this.saveState(true)
    const outline = this.state.outlineByCourse[courseId] || null
    if (!outline) {
      const job = this.enqueueJob({
        type: 'outline',
        taskId: null,
        title: '刷新章节大纲',
        run: (jobRef, signal) => this.runRefreshOutline(jobRef, { courseId }, signal),
      })
      return { selectedCourseId: courseId, outline: null, job: jobView(job) }
    }
    return { selectedCourseId: courseId, outline }
  }

  async actionRefreshOutline(input) {
    const courseId = cleanString(input?.courseId, 80) || this.state.selectedCourseId
    const course = this.state.courses.find(item => item.id === courseId)
    if (!course) throw new Error('还没有选中课程，先刷新并选一门课。')
    if (this.state.selectedCourseId !== courseId) this.state.selectedCourseId = courseId
    const job = this.enqueueJob({
      type: 'outline',
      taskId: null,
      title: `刷新大纲：${course.title}`,
      run: (jobRef, signal) => this.runRefreshOutline(jobRef, { courseId }, signal),
    })
    return { job: jobView(job) }
  }

  async runRefreshOutline(job, input = {}, signal) {
    const page = await this.acquirePage()
    job.phase = '检查登录'
    job.percent = 8
    await this.requireLoggedIn(page)
    if (signal?.aborted) throw new Error('任务已取消')
    const courseId = cleanString(input?.courseId, 80) || this.state.selectedCourseId
    const course = this.state.courses.find(item => item.id === courseId)
    if (!course) throw new Error('没有这门课程，先刷新课程列表。')
    job.phase = '读取章节'
    job.percent = 25
    job.message = `正在读取「${course.title}」的章节…`
    const outline = await mooc.readOutline(page, course)
    if (!outline || !Array.isArray(outline.chapters) || !outline.chapters.length) {
      throw new Error('没有读到章节结构。可能是课程页需要先选课/单元列表还没加载，点「打开中国大学 MOOC」看一眼，或稍后重试。')
    }
    const normalized = {
      courseId: course.id,
      fetchedAt: nowIso(),
      source: outline.source || 'dom',
      // 讨论标记版本 + 课次讨论信息（老版 SPOC 从课件页 DOM 补出来的）
      discussionFlagVersion: Number(outline.discussionFlagVersion) || 0,
      // 按真实章节序数排好，避免接口把「第15周」排在「第14周」前面
      chapters: sortOutlineChapters(outline.chapters.map((chapter, index) => ({
        id: cleanString(chapter.id, 120) || `${course.id}:chapter:${index + 1}`,
        index: Number.isFinite(chapter.index) ? chapter.index : index + 1,
        title: cleanString(chapter.title, 200) || `第 ${index + 1} 章`,
        units: (Array.isArray(chapter.units) ? chapter.units : []).map((unit, unitIndex) => ({
          id: cleanString(unit.id, 160) || `${course.id}:unit:${index + 1}:${unitIndex + 1}`,
          title: cleanString(unit.title, 200) || `单元 ${unitIndex + 1}`,
          kind: ['video', 'doc', 'quiz', 'homework', 'exam', 'discussion', 'other'].includes(unit.kind) ? unit.kind : 'other',
          url: cleanString(unit.url, 800),
          duration: cleanString(unit.duration, 60),
          deadline: cleanString(unit.deadline, 80),
          status: cleanString(unit.status, 60),
          score: cleanString(unit.score, 60),
          // 站点里的原始顺序（同一章内按课次/单元顺序），排序用
          order: Number.isFinite(Number(unit.order)) ? Number(unit.order) : unitIndex,
          // 课次讨论要求：只有 hasDiscussion=true 的视频才生成讨论任务
          hasDiscussion: unit.hasDiscussion === true,
          discussionUnitId: cleanString(unit.discussionUnitId, 160),
          discussionTitle: cleanString(unit.discussionTitle, 240),
          // 进入单元要用：老站 data-cid 选择器 / 点击脚本 / 学习页地址 / 站点类型
          clickSelector: cleanString(unit.clickSelector, 400),
          clickText: cleanString(unit.clickText, 200),
          clickScript: typeof unit.clickScript === 'string' ? unit.clickScript.slice(0, 2000) : '',
          learnUrl: cleanString(unit.learnUrl, 800),
          site: cleanString(unit.site, 20),
        })),
      }))),
    }
    this.state.outlineByCourse[course.id] = normalized
    this.buildTasksForCourse(course, normalized)
    job.percent = 90
    const unitCount = normalized.chapters.reduce((sum, chapter) => sum + chapter.units.length, 0)
    job.message = `${normalized.chapters.length} 章 / ${unitCount} 个单元`
    this.log(`刷新大纲成功：${course.title}，${job.message}`)
    this.saveState(true)
    return { message: job.message }
  }

  // ---------- 任务生成 ----------

  buildTasksForCourse(course, outline) {
    const old = new Map(this.state.tasks.map(task => [task.id, task]))
    const now = nowIso()
    const tasks = []
    const pushTask = (base, previous) => {
      if (previous) {
        tasks.push({ ...base, ...preservedTaskFields(previous) })
      } else {
        tasks.push(base)
        return base
      }
      return tasks[tasks.length - 1]
    }
    const mapKind = (kind) => (kind === 'video' || kind === 'quiz' || kind === 'homework' || kind === 'exam' ? kind : null)

    outline.chapters.forEach((chapter, chapterIndex) => {
      for (const unit of chapter.units || []) {
        const kind = mapKind(unit.kind)
        if (!kind) continue
        const id = `${course.id}:${unit.id}`
        const base = {
          id,
          courseId: course.id,
          courseTitle: course.title,
          courseUrl: course.url || '',
          chapterId: chapter.id,
          chapterIndex,
          chapterTitle: chapter.title,
          unitId: unit.id,
          title: unit.title,
          // 同一章内的真实顺序（视频/文档按课次排，测验/考试排在后面）
          order: Number.isFinite(Number(unit.order)) ? Number(unit.order) : null,
          kind,
          unit: { ...unit, kind },
          url: unit.url || '',
          status: 'idle',
          plannedAt: null,
          attempts: 0,
          score: null,
          maxScore: null,
          progress: { percent: 0, phase: '', message: '', updatedAt: null },
          log: [],
          detail: '',
          createdAt: now,
          updatedAt: now,
        }
        const previous = old.get(id)
        const created = pushTask(base, previous)
        if (!previous && /已完成|已提交|已批改|满分/.test(unit.status || '')) {
          created.status = 'done'
          created.detail = `课程页显示：${unit.status}`
        }
        if (!previous && typeof unit.score === 'string') {
          const matched = unit.score.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
          if (matched) {
            created.score = Number(matched[1])
            created.maxScore = Number(matched[2])
          }
        }

        if (kind === 'video' && unit.hasDiscussion === true) {
          const discussionId = `${course.id}:${unit.id}:discuss`
          const discussionBase = {
            ...base,
            id: discussionId,
            kind: 'discussion',
            title: `讨论：${unit.title}`,
            detail: unit.discussionTitle ? `课程讨论要求：${unit.discussionTitle}` : '',
          }
          const oldDiscussion = old.get(discussionId)
          pushTask(discussionBase, oldDiscussion)
        }
      }
    })

    const other = this.state.tasks.filter(task => task.courseId !== course.id)
    this.state.tasks = [...other, ...tasks]
    this.saveState(true)
  }

  tasksFor(courseId) {
    const kindRank = { video: 0, discussion: 1, quiz: 2, homework: 3, exam: 4 }
    return this.state.tasks
      .filter(task => task.courseId === courseId)
      .sort((a, b) => {
        // 先按章节真实序数（第2周 < 第10周），不能按字符串比
        const chapterA = chapterOrdinal(a.chapterTitle, a.chapterIndex)
        const chapterB = chapterOrdinal(b.chapterTitle, b.chapterIndex)
        if (chapterA !== chapterB) return chapterA - chapterB
        // 再按同一章里「第X节」的真实顺序；没有 order 的老任务用标题里的序数兜底
        const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : (sectionOrdinal(a.title) ?? 9999)
        const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : (sectionOrdinal(b.title) ?? 9999)
        if (orderA !== orderB) return orderA - orderB
        const kindDiff = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
        if (kindDiff) return kindDiff
        return String(a.title).localeCompare(String(b.title), 'zh')
      })
  }

  lessonKey(courseId, unitId) {
    return `${courseId}:${unitId}`
  }

  getLessonNote(courseId, unitId) {
    return this.state.lessonNotes[this.lessonKey(courseId, unitId)] || null
  }

  saveLessonNote(courseId, unitId, note) {
    if (!note) return
    this.state.lessonNotes[this.lessonKey(courseId, unitId)] = {
      summary: truncate(String(note.summary || ''), 4000),
      keyPoints: Array.isArray(note.keyPoints) ? note.keyPoints.slice(0, 10) : [],
      confusion: truncate(String(note.confusion || ''), 1000),
      transcript: truncate(String(note.transcript || ''), 24000),
      at: note.at || nowIso(),
    }
    this.saveState(true)
  }

  // ---------- 队列 / 任务执行 ----------

  enqueueJob({ type, taskId = null, title = '', run }) {
    const job = {
      id: randomUUID(),
      type,
      taskId,
      taskTitle: title || '',
      status: 'queued',
      percent: 0,
      phase: '排队中',
      message: '',
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
    }
    this.state.jobs.unshift(job)
    const maxJobs = Math.max(10, Number(this.settings.maxJobs) || 40)
    if (this.state.jobs.length > maxJobs) this.state.jobs = this.state.jobs.slice(0, maxJobs)
    this.queue.push({ job, run })
    this.saveState()
    this.pump()
    return job
  }

  async pump() {
    if (this.pumping || this.current || this.disposed) return
    this.pumping = true
    try {
      while (this.queue.length && !this.disposed) {
        const item = this.queue.shift()
        this.current = item
        this.currentAbort = new AbortController()
        const { job } = item
        job.status = 'running'
        job.phase = '开始'
        job.percent = 1
        job.startedAt = job.startedAt || nowIso()
        this.saveState(true)
        try {
          const result = await item.run(job, this.currentAbort.signal)
          job.status = 'done'
          job.percent = 100
          job.phase = '完成'
          job.message = cleanString(result?.message, 400) || job.message || '完成'
        } catch (error) {
          const cancelled = this.currentAbort?.signal?.aborted || /任务已取消/.test(messageOf(error))
          job.status = cancelled ? 'cancelled' : 'failed'
          job.phase = cancelled ? '已取消' : '失败'
          job.error = messageOf(error)
          job.message = messageOf(error)
          this.log(`任务失败：${messageOf(error)}`, cancelled ? 'warn' : 'error')
          if (job.taskId) {
            const task = this.state.tasks.find(entry => entry.id === job.taskId)
            if (task) {
              task.status = cancelled ? 'idle' : 'failed'
              task.progress = {
                percent: task.progress?.percent || 0,
                phase: cancelled ? '已取消' : '失败',
                message: messageOf(error),
                updatedAt: nowIso(),
              }
              this.appendTaskLog(task, job.error)
              task.updatedAt = nowIso()
              // 计划截止时间：失败/需要人工时暂停这门课的自动执行。
              // 失败或需要人工：保留 autoRun 标记，用户把当前任务处理完后，后面的任务会继续按计划顺序补跑；
              // 用户主动取消：视为不想继续这个排期，清掉 autoRun，等用户重新设置截止时间。
              if (task.autoRun) {
                if (cancelled) {
                  for (const other of this.tasksFor(task.courseId)) {
                    if (other.autoRun) {
                      other.autoRun = false
                      other.updatedAt = nowIso()
                    }
                  }
                  this.appendTaskLog(task, '自动执行已停止：需要继续时重新设置计划截止时间')
                } else {
                  this.appendTaskLog(task, '自动执行已暂停：处理完这个任务后，后面的任务会继续按计划顺序补跑')
                  this.log(`自动执行暂停，等待处理：${task.title}`, 'warn')
                }
              }
            }
          }
        } finally {
          job.finishedAt = nowIso()
          this.current = null
          this.currentAbort = null
          this.saveState(true)
          // 任务结束（包括失败/取消）先把旧视频暂停，避免浏览器后台继续播放
          await this.stopBackgroundPlayback({ force: true }).catch(() => {})
          // 任务结束后马上看下一个到点的计划任务
          void this.pumpScheduled()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  async actionRunTask(input) {
    const taskId = cleanString(input?.taskId, 160)
    const task = this.state.tasks.find(entry => entry.id === taskId)
    if (!task) throw new Error('任务不存在，刷新一下章节大纲再试。')
    if (this.current) {
      if (this.current.job.taskId === taskId) throw new Error('这个任务已经在执行了。')
      throw new Error(`现在正在执行「${this.current.job.taskTitle || '别的任务'}」，等它完成再开始，避免浏览器打架。`)
    }
    task.status = 'queued'
    task.progress = { percent: 0, phase: '排队中', message: '等待开始', updatedAt: nowIso() }
    task.updatedAt = nowIso()
    this.appendTaskLog(task, '已加入执行队列')
    const job = this.enqueueJob({
      type: 'task',
      taskId: task.id,
      title: task.title,
      run: (jobRef, signal) => this.runTaskExecution(task, jobRef, signal),
    })
    return { job: jobView(job) }
  }

  async runTaskExecution(task, job, signal) {
    // 浏览器没开就自动开：开着「后台执行」且已登录时用无头实例，不弹窗口
    task.progress = {
      percent: 1,
      phase: '准备浏览器',
      message: this.settings.backgroundExecution ? '后台打开浏览器…' : '打开浏览器…',
      updatedAt: nowIso(),
    }
    job.phase = '准备浏览器'
    job.message = task.progress.message
    this.saveState()
    const page = await this.acquirePage()
    if (signal?.aborted) throw new Error('任务已取消')
    // 执行前确认登录还有效：浏览器里的登录态会过期，但 state 里可能还显示已登录
    const loginNow = await mooc.checkLogin(page).catch(() => null)
    if (loginNow && loginNow.loggedIn !== true) {
      this.applyLoginState(loginNow)
      this.saveState(true)
      throw new Error('登录已失效：请点「登录」重新登录一次，再重试这个任务。')
    }
    task.status = 'running'
    task.progress = { percent: 1, phase: '准备', message: '开始执行', updatedAt: nowIso() }
    task.updatedAt = nowIso()
    this.appendTaskLog(task, this.ensuredHeadless ? '开始执行（后台无头浏览器，不弹窗口）' : '开始执行')
    this.saveState(true)

    // 无头浏览器听不到声音，强制静音，避免自动播放被浏览器拦
    const effectiveSettings = this.ensuredHeadless ? { ...this.settings, videoMuted: true } : this.settings

    const report = (patch = {}) => {
      const percentValue = percent(patch.percent)
      task.progress = {
        percent: percentValue,
        phase: cleanString(patch.phase, 80) || task.progress.phase,
        message: truncate(String(patch.message || ''), 300, '…'),
        updatedAt: nowIso(),
      }
      job.percent = percentValue
      job.phase = task.progress.phase
      job.message = task.progress.message
      if (patch.logLine) this.appendTaskLog(task, patch.logLine)
      task.updatedAt = nowIso()
      this.saveState()
    }

    let result
    try {
      result = await runTask({
        task,
        page,
        settings: effectiveSettings,
        mooc,
        brain: {
          answerQuizWithModel: input => answerQuizWithModel(this.ctx, input),
          writeDiscussionQuestion: input => writeDiscussionQuestion(this.ctx, input),
          summarizeLesson: input => summarizeLesson(this.ctx, input),
        },
        onProgress: report,
        signal,
        log: text => { this.appendTaskLog(task, text); this.log(`[${task.title}] ${text}`) },
        getLessonNote: (courseId, unitId) => this.getLessonNote(courseId, unitId),
        saveLessonNote: (courseId, unitId, note) => this.saveLessonNote(courseId, unitId, note),
        updateTask: patch => {
          Object.assign(task, patch)
          task.updatedAt = nowIso()
          this.saveState(true)
        },
      })
    } catch (error) {
      task.status = 'failed'
      task.progress = { percent: task.progress?.percent || 0, phase: '失败', message: messageOf(error), updatedAt: nowIso() }
      this.appendTaskLog(task, `失败：${messageOf(error)}`)
      task.updatedAt = nowIso()
      this.saveState(true)
      throw error
    }

    const status = result?.status === 'needs-user' ? 'needs-user' : result?.ok === false ? 'needs-user' : 'done'
    task.status = status
    if (typeof result?.score === 'number') task.score = result.score
    if (typeof result?.maxScore === 'number') task.maxScore = result.maxScore
    if (result?.detail) task.detail = truncate(result.detail, 600, '…')
    task.progress = {
      percent: status === 'done' ? 100 : (task.progress?.percent || 0),
      phase: status === 'done' ? '完成' : '待确认',
      message: result?.detail || '',
      updatedAt: nowIso(),
    }
    this.appendTaskLog(task, result?.detail || (status === 'done' ? '完成' : '需要确认'))
    task.updatedAt = nowIso()
    this.saveState(true)
    job.message = result?.detail || job.message

    if (status === 'done' && task.kind === 'video' && this.settings.autoDiscussAfterVideo) {
      this.queueDiscussionFor(task)
    }
    return { message: result?.detail || '' }
  }

  queueDiscussionFor(videoTask) {
    const discussionId = `${videoTask.courseId}:${videoTask.unitId}:discuss`
    const discussion = this.state.tasks.find(task => task.id === discussionId)
    if (!discussion) return
    if (discussion.status === 'done' || discussion.status === 'running' || discussion.status === 'queued') return
    if (this.queue.some(entry => entry.job.taskId === discussionId)) return
    discussion.status = 'queued'
    discussion.progress = { percent: 0, phase: '排队中', message: '上完课了，准备去讨论区提问', updatedAt: nowIso() }
    discussion.updatedAt = nowIso()
    this.appendTaskLog(discussion, '上完课，自动排队提问')
    this.enqueueJob({
      type: 'task',
      taskId: discussion.id,
      title: discussion.title,
      run: (jobRef, signal) => this.runTaskExecution(discussion, jobRef, signal),
    })
    this.log(`自动排队讨论任务：${discussion.title}`)
  }

  async actionCancelTask(input) {
    const taskId = cleanString(input?.taskId, 160)
    const task = this.state.tasks.find(entry => entry.id === taskId)
    if (!task) throw new Error('任务不存在')
    if (this.current && this.current.job.taskId === taskId) {
      try { this.currentAbort?.abort() } catch { /* ignore */ }
      this.current.job.status = 'cancelled'
      this.current.job.phase = '已取消'
      this.current.job.finishedAt = nowIso()
      task.status = 'idle'
      task.progress = { percent: 0, phase: '已取消', message: '用户取消了这个任务', updatedAt: nowIso() }
      task.updatedAt = nowIso()
      this.appendTaskLog(task, '用户取消')
      this.saveState(true)
      return { job: jobView(this.current.job) }
    }
    const index = this.queue.findIndex(entry => entry.job.taskId === taskId)
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1)
      entry.job.status = 'cancelled'
      entry.job.phase = '已取消'
      entry.job.finishedAt = nowIso()
      task.status = 'idle'
      task.progress = { percent: 0, phase: '已取消', message: '用户取消了这个任务', updatedAt: nowIso() }
      task.updatedAt = nowIso()
      this.appendTaskLog(task, '用户取消')
      this.saveState(true)
      return { job: jobView(entry.job) }
    }
    task.status = 'idle'
    task.progress = { percent: 0, phase: '', message: '', updatedAt: nowIso() }
    task.updatedAt = nowIso()
    this.saveState(true)
    return {
      job: { id: randomUUID(), taskId, taskTitle: task.title, status: 'cancelled', percent: 0, phase: '已取消', message: '没有正在执行的任务', startedAt: nowIso(), finishedAt: nowIso(), error: null },
    }
  }

  async actionPlanTask(input) {
    const taskId = cleanString(input?.taskId, 160)
    const task = this.state.tasks.find(entry => entry.id === taskId)
    if (!task) throw new Error('任务不存在')
    task.plannedAt = isoOrNull(input?.plannedAt)
    if (!task.plannedAt) task.autoRun = false
    task.updatedAt = nowIso()
    this.saveState(true)
    return { task }
  }

  /**
   * 设置「计划截止时间」：把这个任务及它之前所有未完成的任务，按章节顺序排好完成时间，
   * 时间随机落在每天 8:00–24:00 之间，最后一个不晚于截止时间；到点后自动按顺序执行。
   */
  async actionScheduleDeadline(input) {
    const taskId = cleanString(input?.taskId, 160)
    const task = this.state.tasks.find(entry => entry.id === taskId)
    if (!task) throw new Error('任务不存在，刷新一下章节大纲再试。')
    const deadline = new Date(String(input?.deadline || ''))
    if (Number.isNaN(deadline.getTime())) throw new Error('截止时间格式不对，请重新选择。')
    const ordered = this.tasksFor(task.courseId)
    const index = ordered.findIndex(entry => entry.id === task.id)
    if (index < 0) throw new Error('任务不在当前课程里，先刷新章节大纲。')
    const prefix = ordered
      .slice(0, index + 1)
      .filter(entry => entry.status !== 'done' && entry.status !== 'skipped')
    if (!prefix.length) {
      return { count: 0, planned: [], message: '这个任务和它之前的任务都已经完成了。' }
    }
    const start = Date.now() + 60_000
    const times = planCompletionTimes(prefix.length, start, deadline.getTime())
    prefix.forEach((entry, offset) => {
      entry.plannedAt = new Date(times[offset]).toISOString()
      entry.autoRun = true
      entry.updatedAt = nowIso()
      this.appendTaskLog(entry, `已安排自动完成：最晚 ${new Date(times[offset]).toLocaleString('zh-CN', { hour12: false })}`)
    })
    // 已经完成的旧任务清掉自动标记，避免之后重复跑
    for (const entry of ordered.slice(0, index + 1)) {
      if ((entry.status === 'done' || entry.status === 'skipped') && entry.autoRun) entry.autoRun = false
    }
    this.saveState(true)
    void this.pumpScheduled()
    return {
      count: prefix.length,
      deadline: deadline.toISOString(),
      planned: prefix.map(entry => ({ id: entry.id, title: entry.title, plannedAt: entry.plannedAt })),
    }
  }

  /** 检查有没有到点的计划任务，有就按章节顺序自动加入执行队列（同一时间只跑一个）。 */
  async pumpScheduled() {
    if (this.disposed || this.current || this.queue.length || this.schedulerBusy) return
    this.schedulerBusy = true
    try {
      const now = Date.now()
      const courseIds = [...new Set(this.state.tasks.filter(task => task.autoRun).map(task => task.courseId))]
      let candidate = null
      for (const courseId of courseIds) {
        const ordered = this.tasksFor(courseId)
        let paused = false
        for (const task of ordered) {
          if (!task.autoRun) continue
          if (task.status === 'done' || task.status === 'skipped') {
            task.autoRun = false
            task.updatedAt = nowIso()
            continue
          }
          // 顺序执行：前面的任务还没成功，就先不跑后面的
          if (task.status === 'failed' || task.status === 'needs-user') {
            paused = true
            break
          }
          if (!task.plannedAt) {
            task.autoRun = false
            task.updatedAt = nowIso()
            break
          }
          if (task.status === 'idle' && new Date(task.plannedAt).getTime() <= now) candidate = task
          break
        }
        if (candidate || paused) break
      }
      if (!candidate) return
      candidate.status = 'queued'
      candidate.progress = { percent: 0, phase: '排队中', message: '到达计划截止时间，自动开始', updatedAt: nowIso() }
      candidate.updatedAt = nowIso()
      this.appendTaskLog(candidate, '到达计划截止时间，自动加入执行队列')
      this.enqueueJob({
        type: 'task',
        taskId: candidate.id,
        title: candidate.title,
        run: (jobRef, signal) => this.runTaskExecution(candidate, jobRef, signal),
      })
      this.log(`计划任务到点，自动开始：${candidate.title}`)
    } catch (error) {
      this.log(`计划任务自动执行失败：${messageOf(error)}`, 'warn')
    } finally {
      this.schedulerBusy = false
    }
  }

  // ---------- 设置 ----------

  sanitizeSettings(patch) {
    const next = { ...this.settings }
    for (const [key, value] of Object.entries(patch || {})) {
      if (!SETTING_KEYS.has(key)) continue
      switch (key) {
        case 'nickname': next.nickname = cleanString(value, 40); break
        case 'videoSpeed': next.videoSpeed = Math.min(4, Math.max(1, Number(value) || 2)); break
        case 'videoMuted': next.videoMuted = value === true; break
        case 'autoDiscussAfterVideo': next.autoDiscussAfterVideo = value !== false; break
        case 'quizRepairSecondAttempt': next.quizRepairSecondAttempt = value !== false; break
        case 'examAttempts': next.examAttempts = Math.min(3, Math.max(1, Number(value) || 1)); break
        case 'quizFillStrategy': next.quizFillStrategy = ['model', 'model+knowledge'].includes(value) ? value : 'model+knowledge'; break
        case 'reasoningEffort': next.reasoningEffort = EFFORTS.has(value) ? value : 'medium'; break
        case 'browserPort': next.browserPort = Math.min(65000, Math.max(1024, Number(value) || 9233)); break
        case 'browserPath': next.browserPath = cleanString(value, 600); break
        case 'maxJobs': next.maxJobs = Math.min(200, Math.max(10, Number(value) || 40)); break
        case 'autoRefreshCourses': next.autoRefreshCourses = value === true; break
        case 'backgroundExecution': next.backgroundExecution = value !== false; break
        default: break
      }
    }
    return next
  }

  async actionSetSetting(input) {
    const key = cleanString(input?.key, 80)
    if (!SETTING_KEYS.has(key)) throw new Error(`没有这项设置：${key}`)
    this.settings = this.sanitizeSettings({ [key]: input?.value })
    this.saveSettings()
    if (key === 'browserPort') {
      this.browser = null
      this.page = null
      this.browserInfo.port = this.settings.browserPort
      this.browserInfo.running = false
    }
    if (['browserPath', 'browserPort'].includes(key)) void this.runEnvironmentCheck()
    return { settings: this.settings }
  }

  async actionSaveSettings(input) {
    const patch = input?.settings && typeof input.settings === 'object' ? input.settings : {}
    this.settings = this.sanitizeSettings(patch)
    this.saveSettings()
    this.log('设置已保存')
    void this.runEnvironmentCheck()
    return { settings: this.settings }
  }

  async actionClearLog() {
    this.state.log = []
    this.saveState(true)
    return { ok: true }
  }

  // ---------- 诊断 ----------

  async actionDiagnostics(input) {
    const checks = []
    let dumpPath = null
    let page = null
    try {
      page = await this.acquirePage()
      checks.push({ name: '受控浏览器已启动', ok: true, detail: `端口 ${Number(this.settings.browserPort) || 9233}` })
      checks.push({
        name: '执行模式',
        ok: true,
        detail: this.settings.backgroundExecution
          ? (this.ensuredHeadless ? '后台执行（无头浏览器，不弹窗口）' : '后台执行已开启：登录时用可见窗口，任务在后台跑')
          : '可见窗口模式',
      })
    } catch (error) {
      checks.push({ name: '受控浏览器已启动', ok: false, detail: messageOf(error) })
    }
    if (page) {
      try {
        const items = await mooc.selfCheck(page)
        if (Array.isArray(items)) checks.push(...items)
      } catch (error) {
        checks.push({ name: '站点自检', ok: false, detail: messageOf(error) })
      }
      if (input?.dumpPage) {
        try {
          const stamp = nowIso().replace(/[:.]/g, '-')
          const file = path.join(shotsDir(), `dump-${stamp}.txt`)
          const text = await page.text()
          const url = await page.url().catch(() => '')
          fs.writeFileSync(file, `URL: ${url}\n抓取时间: ${nowIso()}\n\n${text}`, 'utf8')
          dumpPath = file
          checks.push({ name: '页面快照', ok: true, detail: file })
        } catch (error) {
          checks.push({ name: '页面快照', ok: false, detail: messageOf(error) })
        }
      }
    }
    await this.refreshBrowserInfo().catch(() => {})
    return { checks, dumpPath, browser: this.browserView(), login: this.loginView() }
  }

  // ---------- 快照 ----------

  summary(tasks) {
    const total = tasks.length
    const done = tasks.filter(task => task.status === 'done').length
    const count = (kind, status) => tasks.filter(task => task.kind === kind && (!status || task.status === status)).length
    const videoTotal = count('video')
    const quizTotal = count('quiz') + count('homework')
    const examTotal = count('exam')
    const discussionTotal = count('discussion')
    const scored = tasks.filter(task => typeof task.score === 'number' && typeof task.maxScore === 'number' && task.maxScore > 0)
    const averageScore = scored.length
      ? scored.reduce((sum, task) => sum + task.score / task.maxScore, 0) / scored.length
      : null
    return {
      taskCount: total,
      doneCount: done,
      videoDone: count('video', 'done'),
      videoTotal,
      quizDone: count('quiz', 'done') + count('homework', 'done'),
      quizTotal,
      examDone: count('exam', 'done'),
      examTotal,
      discussionDone: count('discussion', 'done'),
      discussionTotal,
      averageScore,
      pendingCount: tasks.filter(task => task.status === 'idle' || task.status === 'queued').length,
    }
  }

  snapshot() {
    const selectedCourseId = this.state.selectedCourseId
    const storedOutline = selectedCourseId ? this.state.outlineByCourse[selectedCourseId] || null : null
    // 老数据里的章节顺序可能是接口原样（如第15周在第14周前），展示时也按真实序数排
    const outline = storedOutline
      ? { ...storedOutline, chapters: sortOutlineChapters(storedOutline.chapters) }
      : null
    const tasks = selectedCourseId ? this.tasksFor(selectedCourseId) : []
    const jobs = this.state.jobs.slice(0, Math.max(10, Number(this.settings.maxJobs) || 40)).map(jobView)
    return {
      now: nowIso(),
      pluginVersion: PLUGIN_VERSION,
      settings: this.settings,
      environment: this.environment || { status: 'checking', ok: null, checks: [], checkedAt: null },
      account: this.accountView(),
      browser: this.browserView(),
      login: this.loginView(),
      courses: this.state.courses,
      selectedCourseId,
      outline,
      tasks,
      jobs,
      summary: this.summary(tasks),
      log: this.state.log.slice(-LOG_LIMIT),
    }
  }
}

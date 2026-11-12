// 本地 UI 调试页生成器：把真实 state.json 做成快照，配一个打包好的 React，渲染 client.js 的 Page。
//   node scripts/dev-harness.mjs
// 生成 docs/harness/index.html，用浏览器打开即可（不连 DSH、不发请求、手机号脱敏）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const pluginDir = path.resolve(import.meta.dirname, '..')
const harnessDir = path.join(pluginDir, 'docs', 'harness')
const home = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'ZJU-mooc-assistant')
const profileModules = process.env.DSH_PROFILE_MODULES || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')

fs.mkdirSync(harnessDir, { recursive: true })

// ── 1. 快照 ────────────────────────────────────────────────────────────────
const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
const account = JSON.parse(fs.readFileSync(path.join(home, 'account.json'), 'utf8'))
const selectedCourseId = state.selectedCourseId
const tasks = (state.tasks || []).filter(task => task.courseId === selectedCourseId)
// 演示用：给前两个任务补上「计划截止时间 + 自动完成」，方便在截图里看新功能
const demoBase = (() => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 30, 0, 0); return date.getTime() })()
tasks.slice(0, 2).forEach((task, index) => {
  task.plannedAt = new Date(demoBase + index * 3 * 60 * 60 * 1000).toISOString()
  task.autoRun = true
})
const outline = selectedCourseId ? state.outlineByCourse[selectedCourseId] : null

function summary(list) {
  const done = list.filter(task => task.status === 'done').length
  const count = (kind, status) => list.filter(task => task.kind === kind && (!status || task.status === status)).length
  const scored = list.filter(task => typeof task.score === 'number' && typeof task.maxScore === 'number' && task.maxScore > 0)
  return {
    taskCount: list.length,
    doneCount: done,
    videoDone: count('video', 'done'),
    videoTotal: count('video'),
    quizDone: count('quiz', 'done') + count('homework', 'done'),
    quizTotal: count('quiz') + count('homework'),
    examDone: count('exam', 'done'),
    examTotal: count('exam'),
    discussionDone: count('discussion', 'done'),
    discussionTotal: count('discussion'),
    averageScore: scored.length ? scored.reduce((sum, task) => sum + task.score / task.maxScore, 0) / scored.length : null,
    pendingCount: list.filter(task => task.status === 'idle' || task.status === 'queued').length,
  }
}

const snapshot = {
  now: new Date().toISOString(),
  settings: {
    videoSpeed: settings.videoSpeed ?? 2,
    videoMuted: settings.videoMuted === true,
    autoDiscussAfterVideo: settings.autoDiscussAfterVideo !== false,
    quizRepairSecondAttempt: settings.quizRepairSecondAttempt !== false,
    examAttempts: settings.examAttempts ?? 1,
    quizFillStrategy: settings.quizFillStrategy || 'model+knowledge',
    reasoningEffort: settings.reasoningEffort || 'medium',
    browserPort: settings.browserPort ?? 9233,
    browserPath: settings.browserPath || '',
    maxJobs: settings.maxJobs ?? 40,
    autoRefreshCourses: settings.autoRefreshCourses === true,
    backgroundExecution: settings.backgroundExecution !== false,
  },
  account: {
    email: '151****3833',
    hasPassword: Boolean(account.password),
    remember: account.remember !== false,
    savedAt: account.savedAt || null,
  },
  browser: { running: true, headless: true, port: 9233, url: 'https://www.icourse163.org/category/all', title: '全部课程_中国大学MOOC(慕课)', startedAt: new Date().toISOString() },
  login: { status: 'logged-in', needUser: null, message: '已登录', user: { name: '小浩' }, at: new Date().toISOString() },
  courses: state.courses || [],
  selectedCourseId,
  outline,
  tasks,
  jobs: (state.jobs || []).slice(0, 5),
  summary: summary(tasks),
  log: (state.log || []).slice(-20),
}
fs.writeFileSync(path.join(harnessDir, 'snapshot.js'), `window.__HARNESS_SNAPSHOT__ = ${JSON.stringify(snapshot, null, 2)}\n`)

// ── 2. 页面与引导 ──────────────────────────────────────────────────────────
const theme = `:root {
  --dsw-alias-bg-base:#1b1d22; --dsw-alias-bg-layer-1:#23262c; --dsw-alias-bg-layer-2:#2b2f37;
  --dsw-alias-border-l1:rgb(255 255 255 / .08); --dsw-alias-border-l2:rgb(255 255 255 / .16);
  --dsw-alias-label-primary:#e8eaed; --dsw-alias-label-secondary:#a9afb8; --dsw-alias-label-tertiary:#7c828c;
  --dsw-alias-interactive-bg-hover:rgb(255 255 255 / .07);
  --dsw-alias-state-business-primary:#4d8dff; --dsw-alias-state-success-primary:#34c759;
  --dsw-alias-state-warn-primary:#f0a020; --dsw-alias-state-error-primary:#ff5a5f;
  --dsw-focus-ring-color:#4d8dff; --dsw-focus-ring-width:2px;
}
html,body{height:100%;margin:0;background:#17191d}body{color:var(--dsw-alias-label-primary)}#app{height:100vh}`

fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>ZJU-mooc-assistant UI 调试</title>
<style>${theme}</style></head>
<body><div id="app"></div>
<script>window.__ModuleLoader__ = { load(definition) { window.__def = definition } }</script>
<script src="react-bundle.js"></script><script src="../../client.js"></script><script src="snapshot.js"></script><script src="harness.js"></script>
</body></html>
`)

fs.writeFileSync(path.join(harnessDir, 'harness.js'), `const snapshot = window.__HARNESS_SNAPSHOT__
window.__harnessErrors = []
window.addEventListener('error', event => window.__harnessErrors.push(String(event.message || event)))
const realFetch = window.fetch.bind(window)
window.fetch = async (url, init) => {
  if (String(url).includes('/api/mooc-companion')) {
    let action = 'status'
    try { action = JSON.parse((init && init.body) || '{}').action || 'status' } catch { /* ignore */ }
    if (action === 'bootstrap' && new URLSearchParams(location.search).get('slow') === '1') {
      await new Promise(resolve => setTimeout(resolve, 4000))
    }
    const value = action === 'bootstrap' || action === 'status' ? snapshot : { ok: true }
    return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(url, init)
}
const definition = window.__def
const requireFn = name => (name === 'react' ? window.React : (name === 'react-dom' ? window.ReactDOM : null))
const registrations = []
definition.factory(requireFn).apply({
  effect(fn) { const dispose = fn(); return () => dispose && dispose() },
  slots: { inject(name, callback) { callback() }, register(slot, component) { registrations.push({ slot, component }); return () => {} } },
})
const main = registrations.find(item => item.slot && item.slot.name === 'main')
window.__createRoot(document.getElementById('app')).render(window.React.createElement(main.component))
`)

// ── 3. React bundle（esbuild-wasm）─────────────────────────────────────────
const bundlePath = path.join(harnessDir, 'react-bundle.js')
if (!fs.existsSync(bundlePath)) {
  const esbuild = createRequire(import.meta.url)(path.join(profileModules, 'node_modules/esbuild-wasm/lib/main.js'))
  await esbuild.initialize({ worker: false })
  await esbuild.build({
    stdin: {
      contents: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nwindow.React = React;\nwindow.__createRoot = createRoot;\n",
      resolveDir: profileModules,
      sourcefile: 'entry.js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    outfile: bundlePath,
    logLevel: 'error',
  })
}
console.log(`harness: ${snapshot.courses.length} courses / ${snapshot.tasks.length} tasks`)
console.log(`file:///${harnessDir.replaceAll('\\', '/')}/index.html`)

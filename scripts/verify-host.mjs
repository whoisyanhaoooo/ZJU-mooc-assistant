/**
 * host 侧集成自检：用假 ctx 拉起 MoocCompanion，直接调用 /api/mooc-companion 的处理函数，
 * 验证 bootstrap / 账号 / 打开浏览器 / 诊断 / 错误路径 / 任务队列这些不依赖真实账号的部分。
 *
 *   node scripts/verify-host.mjs
 *
 * 不联网登录、不提交任何课程任务；只复用 9233 上已启动的受控浏览器（没有就启动一个）。
 * 数据目录切到系统临时目录，测完不污染用户的真实插件数据。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tempHome = path.join(os.tmpdir(), `mooc-verify-${process.pid}`)
fs.mkdirSync(tempHome, { recursive: true })
process.env.DSH_HOME = tempHome

const { MoocCompanion, planCompletionTimes } = await import('../host/service.mjs')

const registrations = []
const logs = []
const ctx = {
  get(key) {
    if (key === 'connection') {
      return {
        fetch: {
          register: async definition => {
            registrations.push(definition)
            return () => {}
          },
        },
      }
    }
    if (key === 'llm') {
      return {
        async *stream() {
          yield { type: 'text-delta', text: '{"ok":true}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    if (key === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
    }
    return undefined
  },
  effect(fn) { const dispose = fn(); return () => dispose?.() },
}

const failures = []
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}${detail ? `（${detail}）` : ''}`)
  else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const service = new MoocCompanion(ctx, { autoMigrate: false })
const dispose = service.start()
try {
  for (let i = 0; i < 50 && !registrations.length; i += 1) await new Promise(r => setTimeout(r, 100))
  check('注册了 /api/mooc-companion', registrations.length === 1, registrations[0]?.path)
  const handler = registrations[0].fetch

  async function call(action, input = {}) {
    const response = await handler(new Request('http://127.0.0.1:51002/api/mooc-companion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, input }),
    }))
    const body = await response.json()
    return { status: response.status, body }
  }

  console.log('\n[1] bootstrap')
  await new Promise(resolve => setTimeout(resolve, 600))
  const boot = await call('bootstrap')
  const snapshot = boot.body.value
  check('返回 200', boot.status === 200, String(boot.status))
  check('snapshot 有 settings', !!snapshot?.settings && snapshot.settings.videoSpeed === 2)
  check('snapshot 有 account/browser/login', !!snapshot?.account && !!snapshot?.browser && !!snapshot?.login)
  check('snapshot 有 courses/tasks/jobs/summary/log', Array.isArray(snapshot?.courses) && Array.isArray(snapshot?.tasks) && Array.isArray(snapshot?.jobs) && !!snapshot?.summary && Array.isArray(snapshot?.log))
  check('默认浏览器端口 9233', snapshot?.browser?.port === 9233, String(snapshot?.browser?.port))
  check('环境自检写入快照', Array.isArray(snapshot?.environment?.checks) && snapshot.environment.checks.length >= 3, JSON.stringify(snapshot?.environment?.checks?.map(item => item.key)))
  check('环境自检覆盖数据目录/浏览器/模型', ['data', 'browser', 'model'].every(key => snapshot?.environment?.checks?.some(item => item.key === key)))

  console.log('\n[2] saveAccount / 密码不外泄')
  const saved = await call('saveAccount', { email: 'test@example.com', password: 'test-password-not-real', remember: true })
  check('保存账号成功', saved.status === 200 && saved.body.value?.account?.email === 'test@example.com')
  check('响应里没有密码', !JSON.stringify(saved.body).includes('test-password-not-real'))
  check('hasPassword = true', saved.body.value?.account?.hasPassword === true)
  const bootAfterSave = (await call('bootstrap')).body.value
  check('bootstrap 也不回传密码', !JSON.stringify(bootAfterSave).includes('test-password-not-real'))
  check('account.json 已落盘', fs.existsSync(path.join(tempHome, 'ZJU-mooc-assistant', 'account.json')))

  console.log('\n[3] openBrowser（真实浏览器）')
  const opened = await call('openBrowser', {})
  check('openBrowser 200', opened.status === 200)
  check('浏览器 running', opened.body.value?.browser?.running === true)
  check('停在中国大学 MOOC', /icourse163\.org/.test(opened.body.value?.browser?.url || ''), opened.body.value?.browser?.url)
  check('拿得到登录状态', !!opened.body.value?.login?.status, opened.body.value?.login?.status)

  console.log('\n[4] diagnostics / selfCheck')
  const diag = await call('diagnostics', { dumpPage: false })
  check('diagnostics 200', diag.status === 200)
  check('checks 是数组且有内容', Array.isArray(diag.body.value?.checks) && diag.body.value.checks.length > 0, `${diag.body.value?.checks?.length} 项`)
  for (const item of diag.body.value?.checks || []) console.log(`      · ${item.ok ? '通过' : '失败'} ${item.name}：${String(item.detail || '').slice(0, 90)}`)

  console.log('\n[5] refreshCourses 未登录时的错误路径')
  const refresh = await call('refreshCourses', {})
  const job = refresh.body.value?.job
  check('返回 job', !!job && typeof job.id === 'string', job?.status)
  let finished = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise(r => setTimeout(r, 300))
    const status = (await call('status')).body.value
    finished = status.jobs.find(item => item.id === job.id)
    if (finished && (finished.status === 'failed' || finished.status === 'done' || finished.status === 'cancelled')) break
  }
  check('job 走到终态', !!finished && ['failed', 'done', 'cancelled'].includes(finished.status), finished?.status)
  check('未登录时给中文提示', finished?.status !== 'done' ? /登录|验证|登录失效/.test(finished?.message || finished?.error || '') : true, String(finished?.message || finished?.error || '').slice(0, 120))

  console.log('\n[6] 错误路径：不存在的任务 / 未知 action')
  const missing = await call('runTask', { taskId: 'nope:1' })
  check('runTask 未知任务返回 error', missing.status === 400 && /不存在|刷新/.test(missing.body.error || ''), missing.body.error)
  const unknown = await call('noSuchAction')
  check('未知 action 返回 error', unknown.status === 400 && /未知操作/.test(unknown.body.error || ''), unknown.body.error)

  console.log('\n[7] settings 校验')
  const badPort = await call('setSetting', { key: 'browserPort', value: 1 })
  check('端口被夹到合法范围', badPort.body.value?.settings?.browserPort >= 1024, String(badPort.body.value?.settings?.browserPort))
  const saved2 = await call('saveSettings', { settings: { videoSpeed: 9, examAttempts: 99, reasoningEffort: 'bogus' } })
  check('倍速夹到 4', saved2.body.value?.settings?.videoSpeed === 4, String(saved2.body.value?.settings?.videoSpeed))
  check('考试次数夹到 3', saved2.body.value?.settings?.examAttempts === 3, String(saved2.body.value?.settings?.examAttempts))
  check('思考强度回落到默认', saved2.body.value?.settings?.reasoningEffort === 'medium', saved2.body.value?.settings?.reasoningEffort)
  const named = await call('setSetting', { key: 'nickname', value: '小浩同学' })
  check('称呼可以保存', named.body.value?.settings?.nickname === '小浩同学', named.body.value?.settings?.nickname)
  const clearedName = await call('setSetting', { key: 'nickname', value: '   ' })
  check('称呼清空后留空，不再回落旧默认名', clearedName.body.value?.settings?.nickname === '', JSON.stringify(clearedName.body.value?.settings?.nickname))

  console.log('\n[8] 启动标记')
  check('runtime.json 已写入', fs.existsSync(path.join(tempHome, 'ZJU-mooc-assistant', 'runtime.json')))
  check('state.json 已写入', fs.existsSync(path.join(tempHome, 'ZJU-mooc-assistant', 'state.json')))

  console.log('\n[9] 讨论区提问语气')
  const brainSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'brain.mjs'), 'utf8')
  check('提问要求只提问和讨论', brainSource.includes('只提问和讨论'))
  check('提问语气为中立平实', brainSource.includes('语气中立、平实'))
  check('不再鼓励带情绪', !brainSource.includes('可以自然带一点真实困惑') && !brainSource.includes('真实困惑'))
  check('禁止表达情绪写进 prompt', brainSource.includes('不要表达情绪'))
  check('讨论优先针对老师的问题', brainSource.includes('优先针对老师在这节课里提出的问题') && brainSource.includes('老师的问题'))
  const execSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'exec.mjs'), 'utf8')
  check('执行时读取讨论区页面作为老师问题来源', execSource.includes('readForumContext') && execSource.includes('forum,'))

  console.log('\n[9b] SPOC 讨论区发帖流程')
  const moocSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'mooc.mjs'), 'utf8')
  check('识别新版「发起主题」按钮', moocSource.includes("'发起主题'") && moocSource.includes('.j-newTopicBtn'))
  check('发帖页会选「综合讨论区」板块', moocSource.includes('请选择主题所属板块'))
  check('标题选择器兼容 j-textarea inputtxt', moocSource.includes('input.j-textarea.inputtxt'))
  check('登录 Cookie 只认 icourse163.org', moocSource.includes("page.cookies('icourse163.org')") && moocSource.includes("endsWith('.icourse163.org')"))
  check('登录弹层要求 tab 真的可见', moocSource.includes('手机号登录|邮箱登录|爱课程登录') && moocSource.includes('filter(isVisible)'))
  check('论坛正文用 CDP 真实输入', moocSource.includes("Input.insertText") && moocSource.includes("mode: 'cdp'"))
  check('发布按钮优先 .j-publish', moocSource.includes('.j-publish'))
  check('按 addPost 接口结果判断发布成功', moocSource.includes('addPost') && moocSource.includes('takeNetwork'))
  check('正文编辑器排除 ql-clipboard', moocSource.includes('contentEditor') && moocSource.includes('ql-clipboard'))
  check('发帖板块选择带重试', moocSource.includes('selectBoard') && moocSource.includes('综合讨论区」板块'))
  check('板块下拉用真实鼠标点击', moocSource.includes('realClickAt(state.rect') && moocSource.includes('selectBoard'))

  console.log('\n[9c] 讨论任务只跟着课程要求走')
  const { chaptersFromTerm } = await import('../host/mooc-web.mjs')
  const parsedOutline = chaptersFromTerm([{ lessons: [
    { units: [
      { id: 'v1', contentType: 1, durationInSeconds: 120, name: '视频一' },
      { id: 'd1', contentType: 6, name: '老师讨论题' },
    ] },
    { units: [
      { id: 'v2', contentType: 1, durationInSeconds: 120, name: '视频二' },
    ] },
  ] }], { id: 'ZJU-1', title: '测试课程', shortName: 'ZJU-1', termId: '1' }, false)
  const parsedUnits = parsedOutline[0].units
  const parsedVideo1 = parsedUnits.find(unit => unit.id === 'v1')
  const parsedVideo2 = parsedUnits.find(unit => unit.id === 'v2')
  check('有 contentType=6 讨论的课次，最后一个视频标记 hasDiscussion', parsedVideo1?.hasDiscussion === true && parsedVideo1?.discussionTitle === '老师讨论题', JSON.stringify(parsedVideo1))
  check('没有讨论单元的课次不标记', parsedVideo2?.hasDiscussion === false)
  check('讨论单元本身不生成任务', !parsedUnits.some(unit => unit.kind === 'discussion'))
  const serviceSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'service.mjs'), 'utf8')
  check('生成讨论任务要求 hasDiscussion=true', serviceSource.includes("kind === 'video' && unit.hasDiscussion === true"))
  check('需要操作的任务可以打开页面', serviceSource.includes("case 'openTaskPage'") && serviceSource.includes('actionOpenTaskPage'))
  check('没有任务时会暂停后台视频', moocSource.includes('pauseVideoPlayback') && serviceSource.includes('stopBackgroundPlayback') && serviceSource.includes('playbackTimer'))
  check('打开任务页前会切到可见浏览器', serviceSource.includes('ensureVisibleBrowser'))
  const cdpSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'host', 'cdp.mjs'), 'utf8')
  check('可以主动关闭后台无头实例', cdpSource.includes('async shutdown()'))
  const { applyLegacyDiscussionFlags } = await import('../host/mooc-web.mjs')
  const domChapters = [{ units: [
    { id: 'dv1', kind: 'video', order: 0 },
    { id: 'dv2', kind: 'video', order: 1 },
    { id: 'dv3', kind: 'video', order: 2 },
  ] }]
  const domRaw = [{ units: [
    { id: 'dv1', tag: '视频', lessonTitle: '第一节' },
    { id: 'dv2', tag: '视频', lessonTitle: '第一节' },
    { id: 'dd1', tag: '讨论', title: '谈谈你对这一节的想法', lessonTitle: '第一节' },
    { id: 'dv3', tag: '视频', lessonTitle: '第二节' },
  ] }]
  applyLegacyDiscussionFlags(domChapters, domRaw)
  check('课件页 DOM 的讨论单元挂到课次最后一个视频', domChapters[0].units[1].hasDiscussion === true && domChapters[0].units[2].hasDiscussion !== true, JSON.stringify(domChapters[0].units))
  check('DOM 讨论标题写入任务', domChapters[0].units[1].discussionTitle === '谈谈你对这一节的想法')

  console.log('\n[10] 计划截止时间（按顺序自动完成）')
  // 生成的时间必须递增、落在每天 8:00–24:00、最后不晚于截止时间
  const start = Date.now() + 60_000
  const deadline = start + 30 * 60 * 60 * 1000
  const times = planCompletionTimes(4, start, deadline)
  check('生成 4 个完成时间', times.length === 4, String(times.length))
  check('时间递增', times.every((time, index) => index === 0 || time > times[index - 1]))
  check('都在每天 8:00 之后', times.every(time => new Date(time).getHours() >= 8), times.map(time => new Date(time).getHours()).join(','))
  check('最后一个不晚于截止时间', times[times.length - 1] <= deadline)
  let earlyError = ''
  try { planCompletionTimes(1, start, start - 60_000) } catch (error) { earlyError = String(error?.message || error) }
  check('截止时间早于现在会报错', /晚于现在/.test(earlyError), earlyError)

  // 设置截止时间：任务及其之前未完成的任务都要排上自动时间
  const fakeCourse = 'verify-deadline-course'
  service.state.tasks = [
    { id: 'vd-1', courseId: fakeCourse, chapterId: 'c1', chapterTitle: '第1周', chapterIndex: 1, order: 1, kind: 'video', title: '测试视频', status: 'idle', plannedAt: null, autoRun: false },
    { id: 'vd-2', courseId: fakeCourse, chapterId: 'c1', chapterTitle: '第1周', chapterIndex: 1, order: 2, kind: 'discussion', title: '测试讨论', status: 'idle', plannedAt: null, autoRun: false },
    { id: 'vd-3', courseId: fakeCourse, chapterId: 'c2', chapterTitle: '第2周', chapterIndex: 2, order: 1, kind: 'video', title: '后面的视频', status: 'idle', plannedAt: null, autoRun: false },
  ]
  const deadlineIso = new Date(deadline).toISOString()
  const scheduled = await service.actionScheduleDeadline({ taskId: 'vd-2', deadline: deadlineIso })
  check('截止时间只安排到目标任务', scheduled.count === 2, String(scheduled.count))
  check('目标及其前面都标记自动完成', service.state.tasks.find(task => task.id === 'vd-1')?.autoRun === true && service.state.tasks.find(task => task.id === 'vd-2')?.autoRun === true)
  check('后面的任务不自动完成', service.state.tasks.find(task => task.id === 'vd-3')?.autoRun === false)
  check('计划截止时间已写入任务', Boolean(service.state.tasks.find(task => task.id === 'vd-2')?.plannedAt))
  let pastError = ''
  try { await service.actionScheduleDeadline({ taskId: 'vd-2', deadline: new Date(Date.now() - 3600_000).toISOString() }) } catch (error) { pastError = String(error?.message || error) }
  check('过去的时间点会报错', /晚于现在|太近/.test(pastError), pastError)

  console.log('\n[11] 到点自动执行（假执行器，不碰浏览器）')
  const executions = []
  service.runTaskExecution = async task => { executions.push(task.id); task.status = 'done'; return { ok: true } }
  const past = new Date(Date.now() - 60_000).toISOString()
  for (let index = 0; index < 50 && (service.current || service.queue.length || service.schedulerBusy); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  service.state.tasks = [
    { id: 'auto-1', courseId: fakeCourse, chapterId: 'c1', chapterTitle: '第1周', chapterIndex: 1, order: 1, kind: 'video', title: '自动1', status: 'idle', plannedAt: past, autoRun: true, log: [] },
    { id: 'auto-2', courseId: fakeCourse, chapterId: 'c1', chapterTitle: '第1周', chapterIndex: 1, order: 2, kind: 'discussion', title: '自动2', status: 'idle', plannedAt: past, autoRun: true, log: [] },
  ]
  await service.pumpScheduled()
  await new Promise(resolve => setTimeout(resolve, 500))
  check('到点任务自动执行', executions.length >= 1 && executions[0] === 'auto-1', executions.join(','))
  check('按顺序执行（先 auto-1 后 auto-2）', executions.length >= 2 && executions[1] === 'auto-2', executions.join(','))

} catch (error) {
  failures.push(`自检抛错：${error?.stack || error?.message || error}`)
  console.error('自检异常：', error)
} finally {
  try { dispose?.() } catch { /* ignore */ }
  try { service.dispose() } catch { /* ignore */ }
}

console.log('')
if (failures.length) {
  console.error(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('host 集成自检全部通过')
process.exit(0)

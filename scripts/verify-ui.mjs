// 迷你 React 渲染冒烟：用假 hooks 把 Page 真正调用一遍，检查：
// 1) 各栏目有收起/展开按钮；2) 章节任务有「课程与筛选」二级折叠；
// 3) 章节是一级菜单，一次只展开一周（点第二周，第一周自动收起）。
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync('client.js', 'utf8')
let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: definition => { captured = definition } },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  },
  document: {
    createElement: () => ({ dataset: {}, set textContent(v) {}, remove() {} }),
    head: { appendChild() {} },
    body: { innerText: '' },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: true, json: async () => ({ value: null }) }),
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

// ---- 迷你 React ----
let rerender = false
const stateStore = []
let hookIndex = 0
let effects = []
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props || {}),
      ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
    },
  }),
  useState(initial) {
    const index = hookIndex++
    if (!(index in stateStore)) stateStore[index] = typeof initial === 'function' ? initial() : initial
    return [stateStore[index], next => {
      stateStore[index] = typeof next === 'function' ? next(stateStore[index]) : next
      rerender = true
    }]
  },
  useEffect(fn) { effects.push(fn) },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
}
const modules = { react: fakeReact }
const definition = captured.factory(name => {
  if (name in modules) return modules[name]
  throw new Error('未知模块 ' + name)
})

const snapshot = {
  now: new Date().toISOString(),
  settings: {
    nickname: '小浩同学',
    videoSpeed: 2, videoMuted: false, autoDiscussAfterVideo: true, quizRepairSecondAttempt: true,
    examAttempts: 1, quizFillStrategy: 'model+knowledge', reasoningEffort: 'medium',
    browserPort: 9233, browserPath: '', maxJobs: 40, autoRefreshCourses: false, backgroundExecution: true,
  },
  account: { email: 'test@example.com', hasPassword: true, remember: true, savedAt: null },
  browser: { running: true, headless: true, port: 9233, url: 'https://www.icourse163.org/category/all', title: '全部课程', startedAt: null },
  login: { status: 'logged-in', needUser: null, message: '已登录', user: { name: '小浩' }, at: null },
  environment: {
    status: 'ready',
    ok: false,
    checks: [
      { key: 'model', ok: false, message: 'DSH 还没有选择默认模型：自动答题、讨论和课堂要点都会失败，请先到 DSH 设置里选一个模型。' },
    ],
    checkedAt: null,
  },
  courses: [{
    id: 'ZJU-1', title: '测试课程', teacher: '', term: '2026/09/01 ~ 2027/01/31', cover: '',
    url: 'https://www.icourse163.org/spoc/learn/ZJU-1?tid=1#/learn/content', spoc: true, state: '进行中', progress: 0.1, school: '测试大学',
  }, {
    id: 'ZJU-2', title: '测试课程二', teacher: '', term: '2026/09/01 ~ 2027/01/31', cover: '',
    url: 'https://www.icourse163.org/spoc/learn/ZJU-2?tid=2#/learn/content', spoc: true, state: '进行中', progress: 0, school: '测试大学',
  }],
  selectedCourseId: 'ZJU-1',
  outline: {
    courseId: 'ZJU-1', fetchedAt: null, source: 'api',
    chapters: [
      { id: 'c1', index: 1, title: '第1周', units: [] },
      { id: 'c2', index: 2, title: '第2周', units: [] },
    ],
  },
  tasks: [
    makeTask('t1', 'c1', 1, '第1周', 'u1', '第一节:有界函数、无界函数、复合函数'),
    makeTask('t2', 'c2', 2, '第2周', 'u2', '第七节:数列的收敛性'),
    makeTask('t3', 'c1', 1, '第1周', 'u3', '第四节:数列极限定义-1', 'needs-user'),
  ],
  jobs: [],
  summary: {
    taskCount: 3, doneCount: 0, pendingCount: 3, videoDone: 0, videoTotal: 3,
    quizDone: 0, quizTotal: 0, examDone: 0, examTotal: 0, discussionDone: 0, discussionTotal: 0, averageScore: null,
  },
  log: [],
}

function makeTask(id, chapterId, chapterIndex, chapterTitle, unitId, title, status) {
  const running = status ? status === 'running' : id === 't1'
  return {
    id, courseId: 'ZJU-1', courseTitle: '测试课程',
    chapterId, chapterIndex, chapterTitle, unitId, title, kind: 'video', status: status || (running ? 'running' : 'idle'),
    plannedAt: id === 't2' ? '2026-11-11T09:30:00+08:00' : null, autoRun: id === 't2', attempts: 0, score: null, maxScore: null,
    progress: { percent: running ? 40 : 0, phase: running ? '正在播放' : '', message: running ? '正在播放：40%（0:12 / 46:23）' : '', updatedAt: null },
    log: [], url: '', detail: '', createdAt: null, updatedAt: null,
  }
}

sandbox.fetch = async () => ({ ok: true, json: async () => ({ value: snapshot }) })

// ---- 迷你渲染器 ----
function expand(node, depth = 0) {
  if (depth > 200 || node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(child => expand(child, depth + 1))
  if (typeof node.type === 'function') return expand(node.type(node.props || {}), depth + 1)
  const props = { ...(node.props || {}) }
  if (props.children) props.children = expand(props.children, depth + 1)
  return { ...node, props }
}

function walk(node, visit) {
  if (node == null) return
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

function collectText(node, out = []) {
  if (node == null) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach(child => collectText(child, out)); return out }
  if (typeof node !== 'object') return out
  collectText(node.props?.children, out)
  return out
}

let PageComponent = null
{
  const registrations = []
  definition.apply({
    effect(fn) { fn(); return () => {} },
    slots: { inject: (name, cb) => cb(), register: (slot, component) => { registrations.push({ slot, component }); return () => {} } },
  })
  PageComponent = registrations.find(item => item.slot?.name === 'main').component
}

const errors = []
async function renderPage() {
  effects = []
  rerender = false
  hookIndex = 0
  const tree = expand(PageComponent({}))
  return { tree, effects: effects.slice() }
}

// 首屏：执行 effects 里的 bootstrap，拿到快照后重渲染
let rendered = await renderPage()
rendered.effects.forEach(fn => { try { fn() } catch (error) { errors.push(error.message) } })
await new Promise(resolve => setTimeout(resolve, 40))
rendered = await renderPage()
const tree = rendered.tree

const checks = []
function check(name, ok) { checks.push([name, ok]) }

const texts = collectText(tree).join(' | ')
const classes = new Set()
const chapterHeads = []
walk(tree, node => {
  const className = String(node.props?.className || '')
  if (className) classes.add(className)
  if (className.includes('mcn-chapter-head')) chapterHeads.push(node)
})

// 课程下拉：常驻展开的筛选区 + 自定义浮层菜单
const triggers = []
walk(tree, node => { if (String(node.props?.className || '').includes('mcn-select-trigger')) triggers.push(node) })

check('渲染页面标题 ZJU-mooc-assistant', texts.includes('ZJU-mooc-assistant'))
check('副标题使用设置里的称呼', texts.includes('小浩同学的中国大学 MOOC 上课助手'))
check('设置里有「怎么称呼你」输入框', texts.includes('怎么称呼你'))
check('文本框统一 8px 圆角 + 半透明玻璃表面', /\.mcn-input[^}]*border-radius:\s*8px/.test(source) && /\.mcn-input[^}]*background:\s*color-mix/.test(source))
check('文本框聚焦是柔和外发光，不是 2px 硬描边', source.includes('.mcn-input:focus, .mcn-select:focus { outline: none;') && source.includes('box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)'))
check('下拉触发器与文本框共用同一套聚焦样式', source.includes('.mcn-select-trigger:focus-visible, .mcn-select-trigger[aria-expanded="true"] { outline: none;') && !source.includes('.mcn-select-trigger[aria-expanded="true"] { border-color: var(--dsw-alias-state-business-primary); outline: 2px'))
check('数字步进器与文本框共用同一套聚焦样式', source.includes('.mcn-stepper:focus-within { outline: none;'))
check('顶部只剩 3 个按钮（打开/登录/刷新）', !texts.includes('检查登录') && !texts.includes('诊断') && texts.includes('刷新'))
check('设置栏不再有「清空日志」', !texts.includes('清空日志'))
check('渲染「章节任务」卡片', texts.includes('章节任务'))
const courseTriggers = triggers.filter(node => String(node.props?.className || '').includes('mcn-course-picker'))
check('课程与筛选常驻展开（没有二级收起栏）', !texts.includes('收起课程与筛选') && courseTriggers.length === 1 && texts.includes('测试课程'))
check('各栏目有收起/展开按钮', texts.includes('收起') && texts.includes('展开'))
check('渲染出「后台执行」摘要', texts.includes('后台执行'))
check('环境自检不通过时页面有提示', texts.includes('DSH 还没有选择默认模型'))
check('渲染出「第1周」「第2周」', texts.includes('第1周') && texts.includes('第2周'))
check('渲染出任务标题', texts.includes('第一节:有界函数'))
check('没有「执行进度」栏目', !texts.includes('执行进度') && ![...classes].some(name => name.includes('mcn-job-head')))
check('运行中的任务行有行内小进度条', [...classes].some(name => name.includes('mcn-task-progress')) && texts.includes('40%'))
const pillActions = []
walk(tree, node => { if (String(node.props?.className || '').includes('mcn-pill-action')) pillActions.push(node) })
check('需要操作的任务有「打开页面」胶囊按钮', pillActions.length === 1 && pillActions[0].props?.children === '打开页面', String(pillActions.length))
check('打开页面按钮会调用 openTaskPage', typeof pillActions[0]?.props?.onClick === 'function')
check('打开页面按钮圆角符合制作规范（9px，不是胶囊形）', /\.mcn-pill-action[^}]*border-radius:\s*9px/.test(source))
check('打开页面按钮高度与右侧小按钮一致（26px）', /\.mcn-pill-action[^}]*height:\s*26px/.test(source))
check('章节头是一级折叠菜单', chapterHeads.length >= 2)
check('默认只展开第一周', chapterHeads[0]?.props?.['aria-expanded'] === 'true' && chapterHeads[1]?.props?.['aria-expanded'] === 'false')

// 点课程下拉：应出现浮层菜单，列出全部课程，当前课程带对勾
if (triggers[0]?.props?.onClick) {
  triggers[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 40, bottom: 120, width: 320 }) } })
}
effects = []
rerender = false
hookIndex = 0
const treeMenu = expand(PageComponent({}))
const menuTexts = collectText(treeMenu).join(' | ')
const menuClasses = new Set()
walk(treeMenu, node => { const cls = String(node.props?.className || ''); if (cls) menuClasses.add(cls) })
check('点课程下拉出现浮层菜单', [...menuClasses].some(name => name.includes('mcn-select-menu')) && menuTexts.includes('测试课程二'))
check('浮层里当前课程高亮并带对勾', menuTexts.includes('测试课程') && [...menuClasses].some(name => name.includes('mcn-select-check')))

// 卡片状态与计划时间浮层
const cards = []
walk(tree, node => { if (node.type === 'section' && String(node.props?.className || '').includes('mcn-card')) cards.push(node) })
const cardTextOf = node => collectText(node).join(' ')
const accountCardNode = cards.find(node => cardTextOf(node).includes('账号与登录'))
const tasksCardNode = cards.find(node => cardTextOf(node).includes('章节任务'))
const planTriggers = []
walk(tree, node => { if (String(node.props?.className || '').includes('mcn-plan-trigger')) planTriggers.push(node) })

check('账号与登录默认收起', accountCardNode?.props?.['data-open'] === 'false')
check('章节任务默认展开', tasksCardNode?.props?.['data-open'] === 'true')
check('每个任务有计划截止时间按钮', planTriggers.length >= 1)
check('计划时间已改名为计划截止时间', collectText(tree).join(' ').includes('计划截止时间') && !collectText(tree).join(' ').includes('计划时间'))
check('已排期的任务显示计划截止时间', collectText(tree).join(' ').includes('2026/11/11 09:30'))
check('已排期的任务带「自动完成」胶囊', collectText(tree).join(' ').includes('自动完成'))
const nativeSelects = []
walk(tree, node => { if (node.type === 'select') nativeSelects.push(node) })
check('设置里不再有原生 select', nativeSelects.length === 0, String(nativeSelects.length))
check('数字设置改成步进器', [...classes].some(name => name.includes('mcn-stepper')))
check('加载圈是完整轨道 + 高亮弧', source.includes('conic-gradient(from 0deg, currentColor 0deg 40deg') && source.includes('mask: radial-gradient(farthest-side'))
check('按钮内加载圈 12px、首屏 11px', source.includes('--mcn-spin-size: 12px') && source.includes('--mcn-spin-size: 11px'))
check('加载圈不再用透明缺口边框', !/mcn-spin[^}]*border-top-color:\s*transparent/.test(source))
check('设置下拉改成自定义触发器', triggers.length >= 3, `实际 ${triggers.length} 个`)

// 点「计划时间」：出现自定义日历 + 时间滚轮浮层
if (planTriggers[0]?.props?.onClick) {
  planTriggers[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 200, bottom: 228, width: 220 }) } })
}
effects = []
rerender = false
hookIndex = 0
const treePlan = expand(PageComponent({}))
const planTexts = collectText(treePlan).join(' | ')
const planClasses = new Set()
walk(treePlan, node => { const cls = String(node.props?.className || ''); if (cls) planClasses.add(cls) })
check('点计划时间出现日历浮层', [...planClasses].some(name => name.includes('mcn-plan-card')) && planTexts.includes('今天') && planTexts.includes('确定'))
check('日历带星期表头', planTexts.includes('一') && planTexts.includes('日'))
check('浮层里有小时/分钟滚轮', [...planClasses].some(name => name.includes('mcn-wheel-item')))

// 点第二周：应切换成只展开第二周
const heads2 = []
walk(treePlan, node => { if (String(node.props?.className || '').includes('mcn-chapter-head')) heads2.push(node) })
const second = heads2[1]
if (second?.props?.onClick) second.props.onClick()
effects = []
rerender = false
hookIndex = 0
const tree2 = expand(PageComponent({}))
const heads3 = []
walk(tree2, node => { if (String(node.props?.className || '').includes('mcn-chapter-head')) heads3.push(node) })
check('点第二周后第一周收起', heads3[0]?.props?.['aria-expanded'] === 'false')
check('点第二周后第二周展开', heads3[1]?.props?.['aria-expanded'] === 'true')


let failed = 0
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failed += 1
}
for (const error of errors) { console.log('  ERROR ' + error); failed += 1 }
console.log('')
if (failed) { console.error(`失败 ${failed} 项`); process.exit(1) }
console.log('UI 渲染冒烟通过（折叠按钮 + 一次只展开一周）')
process.exit(0)

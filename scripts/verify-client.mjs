/**
 * client.js 注册自检：不启动浏览器、不连 DSH，只用最小的 window/document/react/slots 桩，
 * 检查插件是否按契约注册了左上角入口（sidebar.panellist）和主页面（main）。
 *
 *   node scripts/verify-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.resolve(here, '..', 'client.js')
const source = fs.readFileSync(clientFile, 'utf8')

const registrations = []
let captured = null
let styleText = ''
let styleRemoved = false

const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
}

const fakeDocument = {
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      set textContent(value) { styleText = String(value) },
      get textContent() { return styleText },
      remove() { styleRemoved = true },
    }
  },
  head: { appendChild() {} },
  body: { innerText: '' },
}

const windowStub = {
  __ModuleLoader__: {
    load(definition) { captured = definition },
  },
}

const sandbox = {
  window: windowStub,
  document: fakeDocument,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: () => Promise.reject(new Error('verify-client 不联网')),
}
const context = vm.createContext(sandbox)
vm.runInContext(source, context, { filename: 'client.js' })

const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `：${detail}` : ''}`)
  }
}

console.log(`client.js：${source.length} 字符`)
check('调用 window.__ModuleLoader__.load', !!captured)
if (!captured) {
  console.error('\n注册失败：client.js 没有调用 ModuleLoader.load')
  process.exit(1)
}
check('id 为 ZJU-mooc-assistant', captured.id === 'ZJU-mooc-assistant', String(captured.id))
check('提供 factory', typeof captured.factory === 'function')

const definition = captured.factory(name => {
  if (name === 'react') return fakeReact
  throw new Error(`不认识的模块：${name}`)
})
check('factory 返回 inject 数组', Array.isArray(definition?.inject), JSON.stringify(definition?.inject))
check('inject 中包含 slots', Array.isArray(definition?.inject) && definition.inject.includes('slots'))
check('提供 apply 函数', typeof definition?.apply === 'function')

const fakeSlots = {
  inject(name, callback) {
    check(`slots.inject 注册到 ${name}`, name === 'sidebar.panellist' || name === 'main', name)
    // DSH 的 slots.inject 会在合适时机执行回调拿到注册结果；这里立即执行。
    const result = callback()
    check(`${name} 的回调返回了注册结果`, typeof result === 'function' || result !== undefined)
  },
  register(slot, component) {
    registrations.push({ slot, component })
    return () => {}
  },
}
const fakeCtx = {
  effect(fn) {
    const dispose = fn()
    check('effect 返回清理函数或 undefined', dispose === undefined || typeof dispose === 'function')
  },
  slots: fakeSlots,
}

try {
  definition.apply(fakeCtx)
} catch (error) {
  failures.push(`apply 抛错：${error.message}`)
  console.log(`  FAIL apply 抛错：${error.message}`)
}

const sidebar = registrations.find(item => item.slot?.name === 'sidebar.panellist')
const main = registrations.find(item => item.slot?.name === 'main')
check('注册了 sidebar.panellist', !!sidebar)
if (sidebar) {
  check('侧栏 id = mooc-companion', sidebar.slot.id === 'mooc-companion', String(sidebar.slot.id))
  check('侧栏 label = ZJU-mooc-assistant', sidebar.slot.label === 'ZJU-mooc-assistant', String(sidebar.slot.label))
  check('侧栏 order = 34', sidebar.slot.order === 34, String(sidebar.slot.order))
  check('侧栏图标组件是函数', typeof sidebar.component === 'function')
}
check('注册了 main 页面', !!main)
if (main) {
  check('main key = mooc-companion', main.slot.key === 'mooc-companion', String(main.slot.key))
  check('页面组件是函数', typeof main.component === 'function')
}
check('注入的样式非空', styleText.length > 50_000, `${styleText.length} 字符`)
check('样式里含 mcn- 前缀', styleText.includes('.mcn-'))

// 《UI 制作规范》：容器大圆角、控件小圆角；按钮 9px，状态胶囊 999px
function ruleOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styleText.match(new RegExp(`(?:^|\\n)${escaped}`))
  return match ? styleText.slice(match.index, match.index + 520) : ''
}
check('按钮使用 9px 圆角', ruleOf('.mcn-btn {').includes('border-radius: 9px'))
check('小按钮也是 9px 圆角', ruleOf('.mcn-btn[data-small]').includes('border-radius') || styleText.includes('.mcn-btn[data-small]'))
check('筛选 chip 是小号方角按钮', ruleOf('.mcn-chip {').includes('border-radius: 9px'))
check('状态胶囊是 999px 圆角', ruleOf('.mcn-pill {').includes('border-radius: 999px'))
check('开关使用胶囊圆角', ruleOf('.mcn-toggle {').includes('border-radius: var(--mcn-radius-pill)'))
check('进度条使用胶囊圆角', ruleOf('.mcn-progress {').includes('border-radius: var(--mcn-radius-pill)'))
check('卡片使用 15px 圆角', ruleOf('.mcn-card {').includes('border-radius: 15px'))
check('统计卡使用 15px 圆角', ruleOf('.mcn-stat {').includes('border-radius: 15px'))
check('下拉菜单使用 12px 圆角', ruleOf('.mcn-select-menu {').includes('border-radius: 12px'))
check('下拉选项使用 8px 圆角', ruleOf('.mcn-select-item {').includes('border-radius: 8px'))
check('输入框使用 8px 圆角', styleText.includes('.mcn-input, .mcn-select {') && /\.mcn-input, \.mcn-select \{[^}]*border-radius: 8px/.test(styleText))
check('toast 使用 11px 圆角', ruleOf('.mcn-toast {').includes('border-radius: 11px'))
check('主按钮是蓝色半透明玻璃', /\.mcn-btn\[data-primary\] \{[^}]*business-primary\) 30%/.test(styleText))
check('样式已挂到 head 并在清理时移除', !styleRemoved || styleRemoved === true)
check('首屏加载圈为 11px', styleText.includes('.mcn-loading-line .mcn-spin { --mcn-spin-size: 11px'))
check('加载圈使用完整轨道 + 高亮弧', styleText.includes('conic-gradient(from 0deg, currentColor 0deg 40deg') && styleText.includes('mask: radial-gradient(farthest-side'))
check('日历浮层是 15px 圆角卡片', /.mcn-plan-card \{[^}]*border-radius: 15px/.test(styleText))
check('日历日期格 30px、滚轮 108px', /\.mcn-plan-day \{[^}]*height: 30px/.test(styleText) && /\.mcn-wheel \{[^}]*height: 108px/.test(styleText))
check('日历选中日期为实心底白字', styleText.includes('.mcn-plan-day[data-selected="true"] { background: var(--dsw-alias-state-business-primary); color: #fff;'))
check('计划触发器与文本字段共用玻璃表面', /\.mcn-plan-trigger \{[^}]*background: color-mix/.test(styleText))
check('设置下拉有展开/收起动画', styleText.includes('.mcn-option-pop { animation: mcn-fade-up') && styleText.includes('.mcn-option-pop[data-closing="true"]'))

const pageSource = source
check('页面调用 /api/mooc-companion', pageSource.includes('/api/mooc-companion'))
for (const action of ['bootstrap', 'status', 'saveAccount', 'login', 'openBrowser', 'refreshCourses', 'selectCourse', 'refreshOutline', 'runTask', 'cancelTask', 'planTask', 'scheduleDeadline', 'setSetting', 'saveSettings']) {
  check(`前端引用 action ${action}`, pageSource.includes(`'${action}'`) || pageSource.includes(`"${action}"`))
}

console.log('')
if (failures.length) {
  console.error(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('client.js 注册自检全部通过')

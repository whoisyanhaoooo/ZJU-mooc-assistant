/**
 * 中国大学 MOOC（https://www.icourse163.org）站点适配器。
 *
 * 约定与边界：
 * - 所有函数的第一个参数都是 host/cdp.mjs 里的 Page；这里不发登录用的 HTTP 请求，
 *   账号/密码/验证码都交给用户看得见的真实浏览器窗口。
 * - 不依赖 DSH、不依赖 LLM、不引入任何 npm 依赖。
 * - 所有「找不到元素」的情况都抛中文 Error，并把当前页面地址和 innerText 前 2000 字
 *   挂在 error.dump = { url, text } 上，service 会写日志。
 * - 选择器多套兜底：先按 class 模糊匹配，再按文本匹配；登录弹层在跨域 iframe 里时
 *   通过 CDP 的 frame 上下文注入脚本（Page 的 _send / Page.createIsolatedWorld）。
 */

export const URLS = {
  home: 'https://www.icourse163.org/',
  category: 'https://www.icourse163.org/category/all',
  mycourse: 'https://www.icourse163.org/home.htm',
  spocTab: 'https://www.icourse163.org/home.htm#/home/spoc',
  login: 'https://www.icourse163.org/',
  passportPrefix: 'https://reg.icourse163.org/',
  course: 'https://www.icourse163.org/course/',
  learn: 'https://www.icourse163.org/learn/',
  spocLearn: 'https://www.icourse163.org/spoc/learn/',
  userInfoRpc: 'https://www.icourse163.org/web/j/mocMemberFollowBean.userInfo.rpc',
}

/** 登录后网易 passport 会种下的 Cookie 名（NTESSTUDYSI 未登录也有，不能当登录依据）。 */
const LOGIN_COOKIE_NAMES = [
  'STUDY_SESS', 'STUDY_INFO', 'STUDY_PERSIST', 'NTES_SESS', 'P_INFO', 'NTES_PASSPORT', 'S_INFO',
]

const DEFAULT_TIMEOUT = 20_000
const KIND_ORDER = ['exam', 'quiz', 'homework', 'discussion', 'video', 'doc']

import * as web from './mooc-web.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function clean(value, max = 400) {
  const text = typeof value === 'string' ? value : (value == null ? '' : String(value))
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function firstNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text ?? '').match(pattern)
    if (match) {
      const number = Number(String(match[1]).replace(/,/g, ''))
      if (Number.isFinite(number)) return number
    }
  }
  return null
}

/**
 * 根据单元文本和链接猜任务类型。
 * 顺序有讲究：「期末考试」要算 exam，「单元测验」算 quiz，「编程作业」算 homework。
 */
export function classifyKind(text, url = '') {
  const body = clean(text, 500)
  const address = String(url ?? '')
  const combined = `${body} ${address}`
  const hit = patterns => patterns.some(pattern => pattern.test(combined))

  if (hit([/考试|期末考|期中|结课考|exam|final\s*exam/i])) return 'exam'
  if (hit([/测验|测试|随堂测|单元测|小测|quiz|test/i])) return 'quiz'
  if (hit([/作业|homework|assignment|编程题|编程练习/i])) return 'homework'
  if (hit([/讨论|话题|交流|答疑|discussion|forum|bbs/i])) return 'discussion'
  if (hit([/视频|课时|讲座|lecture|video|播放/i])) return 'video'
  if (hit([/文档|课件|讲义|阅读|材料|pdf|doc|reading|富文本/i])) return 'doc'
  return 'other'
}

/** 保证类型在契约允许范围内，并按顺序兜底。 */
function normalizeKind(kind, text, url) {
  const value = String(kind ?? '').trim().toLowerCase()
  if (['video', 'doc', 'quiz', 'homework', 'exam', 'discussion', 'other'].includes(value)) return value
  return classifyKind(text, url)
}

// ---------------------------------------------------------------------------
// 页面脚本注入的公共小工具
// ---------------------------------------------------------------------------

/**
 * 注入到页面里的通用 DOM 工具。注意：这是模板字符串，里面的正则反斜杠要写 \\。
 */
const DOM_HELPERS = String.raw`
  const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const textOf = el => norm(el ? (el.innerText || el.textContent || '') : '');
  const isVisible = el => {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    } catch (error) {
      return false;
    }
    return true;
  };
  const q = (selector, root) => { try { return (root || document).querySelector(selector); } catch (error) { return null; } };
  const qa = (selector, root) => { try { return Array.from((root || document).querySelectorAll(selector)); } catch (error) { return []; } };
  const qVisible = (selectors, root) => {
    for (const selector of selectors) {
      const found = qa(selector, root).filter(isVisible);
      if (found.length) return found;
    }
    return [];
  };
  const firstText = (selectors, root) => {
    for (const element of qVisible(selectors, root)) {
      const text = textOf(element);
      if (text) return text;
    }
    return '';
  };
  const absoluteUrl = value => { try { return new URL(value, location.href).href; } catch (error) { return ''; } };
  const unique = list => Array.from(new Set(list.filter(Boolean)));
  const clickEl = el => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
    try { el.click(); return true; } catch (error) { return false; }
  };
  const setValue = (el, value) => {
    if (!el) return false;
    try { el.focus({ preventScroll: true }); } catch (error) {}
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    } catch (error) { try { el.value = value; } catch (inner) { return false; } }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    } catch (error) {}
    return true;
  };
  const setEditable = (el, value) => {    if (!el) return false;
    try { el.focus({ preventScroll: true }); } catch (error) {}
    let done = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      done = document.execCommand('insertText', false, value);
      if (!done) {
        selection.removeAllRanges();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.addRange(range);
        done = document.execCommand('insertText', false, value);
      }
    } catch (error) { done = false; }
    if (!done) {
      try { el.textContent = value; done = true; } catch (error) { done = false; }
    }
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {}
    return done;
  };
  // 页面里可能有多个 contenteditable（Quill 的 ql-clipboard 也是），取面积最大的那个正文字段
  const contentEditor = () => {
    const list = qa('[contenteditable=true], textarea').filter(isVisible)
      .filter(el => !/ql-clipboard/i.test(String(el.className || '')));
    return list.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    })[0] || null;
  };
  const closestDialog = () => {
    const dialogs = qa('[role=dialog],[class*=dialog],[class*=Dialog],[class*=modal],[class*=Modal],[class*=popup],[class*=Popup]').filter(isVisible);
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  };
`

/** 在主框架里执行一小段同步脚本（自动包一层函数、注入 DOM_HELPERS）。 */
async function run(page, body) {
  const expression = `(() => { ${DOM_HELPERS}\n${body}\n})()`
  return page.eval(expression)
}

/** 在主框架里执行一段异步脚本（可以用 await fetch）。 */
async function runAsync(page, body) {
  const expression = `(async () => { ${DOM_HELPERS}\n${body}\n})()`
  return page.eval(expression)
}

/** 出错时抓当前页面现场，挂到 error.dump。 */
async function snapshot(page) {
  const dump = { url: '', text: '' }
  try { dump.url = String(await page.url()) } catch (error) { /* 页面可能已经关了 */ }
  try { dump.text = String(await page.text()).slice(0, 2000) } catch (error) { /* 忽略 */ }
  return dump
}

async function fail(page, message) {
  const dump = await snapshot(page)
  const error = new Error(message)
  error.dump = dump
  throw error
}

/** 用 error.dump 兜底包装一个内部错误（内部错误也应该已经是中文）。 */
async function wrap(page, message, error) {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const wrapped = new Error(text ? `${message}：${text}` : message)
  wrapped.dump = error?.dump || (await snapshot(page))
  return wrapped
}

// ---------------------------------------------------------------------------
// 跨域 iframe（网易 passport 登录弹层）支持
// ---------------------------------------------------------------------------

function supportsFrames(page) {
  return Boolean(page) && typeof page._send === 'function' && typeof page._ensure === 'function'
}

/** 列出页面 frame 树：[{id, url, name, depth}]。 */
async function listFrames(page) {
  if (!supportsFrames(page)) return []
  try {
    await page._ensure()
    const tree = await page._send('Page.getFrameTree')
    const frames = []
    const walk = (node, depth, parentId) => {
      const frame = node?.frame || {}
      frames.push({
        id: String(frame.id ?? ''),
        url: String(frame.url ?? ''),
        name: String(frame.name ?? ''),
        depth,
        parentId: parentId || '',
      })
      for (const child of node?.childFrames || []) walk(child, depth + 1, frame.id)
    }
    walk(tree?.frameTree, 0, '')
    return frames.filter(frame => frame.id)
  } catch (error) {
    return []
  }
}

/**
 * 在某个 iframe（frame 树节点）里执行脚本。
 * 用 Page.createIsolatedWorld 建一个独立执行环境，再 Runtime.evaluate 指定 contextId。
 * 这样既能操作 iframe 的 DOM（同一份 DOM、事件照样会冒泡到页面监听），又不碰页面自己的全局变量。
 */
async function frameEval(page, frame, expression) {
  if (!supportsFrames(page) || !frame?.id) throw new Error('这个页面没有可用的 iframe 调试通道')
  await page._ensure()
  let world
  try {
    world = await page._send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'mooc-companion-adapter' })
  } catch (error) {
    throw new Error('连接登录框所在 iframe 失败，请刷新页面后重试')
  }
  const contextId = world?.executionContextId
  if (!contextId) throw new Error('登录框所在 iframe 没有可用的执行环境')
  const result = await page._send('Runtime.evaluate', {
    contextId,
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行出错'
    throw new Error(`iframe 里的脚本执行出错：${String(detail).split('\n')[0]}`)
  }
  return result?.result ? result.result.value : null
}

/** 在 iframe 里跑同步脚本（注入 DOM_HELPERS）。 */
async function frameRun(page, frame, body) {
  return frameEval(page, frame, `(() => { ${DOM_HELPERS}\n${body}\n})()`)
}

/**
 * 暂停当前页面（含 iframe）里所有正在播放的音视频。
 * 插件在没有任务时调用，避免 Edge 后台继续播放课程视频、系统媒体控件一直亮着。
 */
export async function pauseVideoPlayback(page) {
  const body = `
    let count = 0;
    for (const media of document.querySelectorAll('video, audio')) {
      try {
        if (!media.paused) { media.pause(); count += 1; }
        media.muted = true;
      } catch (error) {}
    }
    try {
      if (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing') {
        navigator.mediaSession.playbackState = 'paused';
      }
    } catch (error) {}
    return count;
  `
  let count = 0
  try { count += Number(await run(page, body)) || 0 } catch { /* ignore */ }
  for (const frame of (await listFrames(page)).filter(frame => frame.depth >= 1)) {
    try { count += Number(await frameRun(page, frame, body)) || 0 } catch { /* ignore */ }
  }
  return count
}

/** 主框架里每个 iframe 的位置/尺寸，用来判断「哪个登录 tab 真的显示着」。 */
const IFRAME_INFO_BODY = `
  return Array.from(document.querySelectorAll('iframe')).map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      src: el.src || '',
      name: el.name || '',
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      visible: rect.width > 0 && rect.height > 0 && rect.x > -1000 && rect.y > -1000,
    };
  });
`

async function iframeInfos(page) {
  try {
    return await run(page, IFRAME_INFO_BODY) || []
  } catch (error) {
    return []
  }
}

/** 现在的登录弹层/登录 iframe 是否已经打开。 */
const LOGIN_DIALOG_BODY = `
  const text = document.body ? (document.body.innerText || '') : '';
  const modalSeen = qVisible(['.ux-modal_dialog', '#j-login-dialog', '[class*=loginDialog]', '[class*=login-dialog]']).length > 0;
  // 注意：首页会把登录弹层的 DOM 预渲染成隐藏状态，所以不能只看 document.body.innerText；
  // 必须要求「登录 tab 真的可见」，否则会误判为弹层已打开，后面填账号时自然找不到输入框。
  const tabSeen = qa('li,div,span,a,button').filter(isVisible)
    .some(el => /手机号登录|邮箱登录|爱课程登录/.test(textOf(el)));
  return { modalSeen, tabSeen, hasTab: modalSeen || tabSeen };
`

async function loginDialogOpen(page) {
  const main = await run(page, LOGIN_DIALOG_BODY).catch(() => null)
  if (main?.hasTab) return true
  // 只认真正显示着的 passport iframe；隐藏的预渲染 iframe 不算
  const frames = await iframeInfos(page).catch(() => [])
  return frames.some(info => /reg\.icourse163\.org|passport\./i.test(info.src || '') && info.visible)
}

/** 找到登录用的 passport iframe，优先取页面上真正显示着的那个。 */
async function activePassportFrame(page) {
  const frames = (await listFrames(page)).filter(frame => /reg\.icourse163\.org|passport\./i.test(frame.url))
  if (!frames.length) return null
  const infos = (await iframeInfos(page)).filter(info => /reg\.icourse163\.org|passport/i.test(info.src || ''))
  if (infos.length) {
    const visibleIndex = infos.findIndex(info => info.visible)
    if (visibleIndex >= 0 && frames[visibleIndex]) return frames[visibleIndex]
  }
  // 弹层 tab 刚切换时 iframe 可能还没显示；退而求其次，找有登录输入框的那一个
  for (const frame of frames) {
    const form = await frameRun(page, frame, `
      const inputs = qa('input').filter(isVisible);
      return { hasAccount: inputs.some(el => /邮箱|手机号|账号/.test(el.placeholder || '')), hasPassword: inputs.some(el => el.type === 'password') };
    `).catch(() => null)
    if (form?.hasAccount && form?.hasPassword) return frame
  }
  return frames[0]
}

/** 点登录弹层上的 tab（手机号登录 / 邮箱登录 / 爱课程登录）。 */
async function clickLoginTab(page, label) {
  const clicked = await run(page, `
    const wanted = ${JSON.stringify(label)};
    const tabs = qa('li,div,span,a,button').filter(isVisible).filter(el => textOf(el) === wanted);
    for (const tab of tabs) { if (clickEl(tab)) return true; }
    return false;
  `).catch(() => false)
  if (clicked) await sleep(1_200)
  return Boolean(clicked)
}

/** 在登录框里检测输入框类型（手机号 / 邮箱），以及是否有密码框。 */
const LOGIN_FORM_BODY = `
  const inputs = qa('input').filter(isVisible);
  const phone = inputs.find(el => /手机号/.test(el.placeholder || '') || el.type === 'tel' || /phoneipt/.test(el.id || ''));
  const email = inputs.find(el => /邮箱|账号/.test(el.placeholder || '') || /email|account/i.test(el.name || '') || /dlemail/.test(String(el.className || '')) && el.type === 'text');
  const password = inputs.find(el => el.type === 'password') || q('input[type=password]');
  const verify = inputs.find(el => /验证码|校验码/.test(el.placeholder || ''));
  return {
    mode: email && !phone ? 'email' : phone ? 'phone' : 'unknown',
    hasPhone: Boolean(phone),
    hasEmail: Boolean(email),
    hasPassword: Boolean(password),
    needsVerify: Boolean(verify),
    placeholders: inputs.map(el => el.placeholder || '').filter(Boolean).slice(0, 8),
  };
`

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/**
 * 打开站点并打开登录入口。
 * 实测：登录不是独立页面，而是首页右上角「登录 | 注册」弹出的网易 passport 弹层
 * （内部是 reg.icourse163.org 的跨域 iframe），而且 window.eds.loginDialog 只在首页存在。
 */
export async function openLogin(page, opts = {}) {
  const categoryFirst = opts.categoryFirst !== false
  const state = await checkLogin(page).catch(() => null)
  if (state?.loggedIn) return
  let current = ''
  try { current = String(await page.url()) } catch (error) { current = '' }
  const onSite = /icourse163\.org/.test(current) && !/\/error\//.test(current)
  const dialogOpen = await loginDialogOpen(page).catch(() => false)
  if (dialogOpen) return

  // 登录弹层只在首页能可靠打开（分类页上 window.eds 是空的，已实测）。
  if (!onSite) {
    await page.goto(categoryFirst ? URLS.category : URLS.home, { waitMs: 2_800 })
  } else if (categoryFirst && !/category\//.test(current)) {
    // 用户想先看课程分类，就停在分类页；稍后没有登录弹层会自动回首页再试
    await page.goto(URLS.category, { waitMs: 2_600 })
  } else if (!categoryFirst && !/^https:\/\/www\.icourse163\.org\/?(?:#.*)?$/.test(current)) {
    // 服务端登录流程需要首页上的登录弹层
    await page.goto(URLS.home, { waitMs: 2_600 })
  }

  // 分类页没有 eds 时回首页再点
  const openDialog = async () => {
    const hasEds = await run(page, 'return Boolean(window.eds && window.eds.loginDialog && window.eds.loginDialog.showLogin);').catch(() => false)
    if (hasEds) {
      const shown = await run(page, `
        try { window.eds.loginDialog.showLogin(); return true; } catch (error) { return false; }
      `).catch(() => false)
      if (shown) return true
    }
    const selectors = ['.navLoginBtn', '#j-nav-login', '.m-nav-login', '[class*=navLogin]', '[class*=loginBtn]']
    for (const selector of selectors) {
      const exists = await run(page, `return Boolean(q(${JSON.stringify(selector)}));`).catch(() => false)
      if (!exists) continue
      try { await page.click(selector); return true } catch (error) { /* 换下一个 */ }
    }
    for (const text of ['登录 | 注册', '登录/注册', '登录']) {
      const ok = await page.clickText(text, { timeoutMs: 2_000 }).catch(() => false)
      if (ok) return true
    }
    return false
  }

  let tried = await openDialog().catch(() => false)
  if (!tried || !(await loginDialogOpen(page).catch(() => false))) {
    // 分类页上登录入口可能是死的：回首页再试一次
    try { await page.goto(URLS.home, { waitMs: 2_600 }) } catch (error) { /* 忽略 */ }
    tried = await openDialog().catch(() => false)
  }
  const opened = await waitForLoginDialog(page, 12_000)
  if (!opened) {
    throw await fail(page, '没有打开中国大学 MOOC 的登录入口：页面上找不到右上角「登录 / 注册」，可能站点改版或者页面没加载完')
  }
}

async function waitForLoginDialog(page, timeoutMs) {
  const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 12_000)
  while (Date.now() < deadline) {
    if (await loginDialogOpen(page).catch(() => false)) return true
    await sleep(500)
  }
  return false
}

/**
 * 在登录页/弹层/iframe 里填账号和密码。
 * 实测的 passport 结构：
 * - 手机号 tab：`#phoneipt`（type=tel，placeholder 请输入手机号）+ 可见 password（placeholder 请输入密码）
 * - 邮箱 tab：输入框 placeholder「网易邮箱/常用邮箱」+ `.j-inputtext.dlpwd`（placeholder 密码）
 * - 登录按钮：`a.u-loginbtn`（文本「登 录」）
 * 密码只在内存里传给页面，不写日志、不放进错误信息。
 */
export async function fillLogin(page, account = {}) {
  const email = typeof account.email === 'string' ? account.email.trim() : ''
  const password = typeof account.password === 'string' ? account.password : ''
  if (!email) throw new Error('填写登录信息失败：账号是空的')
  if (!password) throw new Error('填写登录信息失败：密码是空的')
  const wantsEmail = email.includes('@')

  let frame = await activePassportFrame(page).catch(() => null)
  if (frame) {
    // tab 和账号格式不一致时先切 tab（邮箱登录 / 手机号登录）
    const form = await frameRun(page, frame, LOGIN_FORM_BODY).catch(() => null)
    if (form) {
      const needTab = wantsEmail ? form.mode === 'phone' : form.mode === 'email'
      if (needTab) {
        const switched = await clickLoginTab(page, wantsEmail ? '邮箱登录' : '手机号登录')
        if (switched) {
          const next = await activePassportFrame(page).catch(() => null)
          if (next) frame = next
        }
      }
    }
    const result = await frameRun(page, frame, `
      const inputs = qa('input').filter(isVisible);
      const accountInput = inputs.find(el => /邮箱|手机号|账号/.test(el.placeholder || ''))
        || inputs.find(el => /dlemail/.test(String(el.className || '')))
        || inputs.find(el => el.type === 'tel' || el.type === 'text');
      const passwordInput = inputs.find(el => el.type === 'password') || q('input[type=password]');
      if (!accountInput) return { ok: false, reason: 'no-account' };
      if (!passwordInput) return { ok: false, reason: 'no-password' };
      setValue(accountInput, ${JSON.stringify(email)});
      setValue(passwordInput, ${JSON.stringify(password)});
      return { ok: true, mode: ${JSON.stringify(wantsEmail ? 'email' : 'phone')}, placeholder: accountInput.placeholder || '' };
    `).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
    if (result?.ok) return { mode: 'iframe', needSubmit: true }
    // 这个 iframe 不行就继续尝试主框架表单
  }

  // 主框架里的「爱课程登录」表单（账号 / 密码两个输入框，提交到 icourseLogin.do）
  const mainForm = await run(page, `
    const inputs = qa('input').filter(isVisible);
    const accountInput = inputs.find(el => /账号|用户名/.test(el.placeholder || ''));
    const passwordInput = inputs.find(el => el.type === 'password');
    if (!accountInput || !passwordInput) return { ok: false };
    accountInput.setAttribute('data-mooc-fill', 'account');
    passwordInput.setAttribute('data-mooc-fill', 'password');
    return { ok: true };
  `).catch(() => null)
  if (mainForm?.ok) {
    await page.type('[data-mooc-fill="account"]', email)
    await page.type('[data-mooc-fill="password"]', password)
    return { mode: 'page', needSubmit: true }
  }

  throw await fail(page, '没有找到账号/密码输入框：登录弹层可能没有打开，或者网易登录框结构变了')
}

/** 点登录按钮。先找 passport iframe 里的 `.u-loginbtn`，再找主框架里的登录按钮。 */
export async function submitLogin(page) {
  const frame = await activePassportFrame(page).catch(() => null)
  if (frame) {
    const clicked = await frameRun(page, frame, `
      const buttons = qa('a,button,input[type=submit],span,div').filter(isVisible).filter(el => {
        const text = textOf(el);
        const cls = String(el.className || '');
        if (el.tagName === 'INPUT') return /登\s*录/.test(el.value || '');
        return /u-loginbtn|loginbtn/i.test(cls) || /^(登\s*录|立即登录|登录)$/.test(text);
      });
      const button = buttons.find(el => /u-loginbtn|loginbtn/i.test(String(el.className || ''))) || buttons[0];
      if (!button) return { ok: false };
      return { ok: clickEl(button), label: textOf(button) };
    `).catch(() => null)
    if (clicked?.ok) return
  }
  const mainClicked = await run(page, `
    const buttons = qa('.submit-button,.button-field button,button,input[type=submit],a,span').filter(isVisible);
    const button = buttons.find(el => {
      const text = textOf(el) || (el.value || '');
      return /^(登\s*录|立即登录|登录)$/.test(text) || /submit-button/i.test(String(el.className || ''));
    });
    if (!button) return { ok: false };
    return { ok: clickEl(button) };
  `).catch(() => null)
  if (mainClicked?.ok) return
  throw await fail(page, '没有找到登录按钮：登录弹层可能已经关掉，请重新点「登录」')
}

/**
 * 登录弹层里需要用户手动处理的东西：滑块验证码 / 短信验证 / 扫码 / 密码错误。
 * 只认「登录弹层真的开着 + 页面上真实可见的验证码容器」；公开页面里的「安全验证」文案、
 * 首页轮播图的 slider 类名都不算，判断不了就返回 needUser:null（宁可说「还没登录」）。
 */
async function detectLoginIssue(page) {
  if (!(await loginDialogOpen(page).catch(() => false))) return { needUser: null, message: '' }

  const main = await run(page, `
    const dialog = closestDialog();
    const root = dialog || document.body;
    const text = root ? (root.innerText || '') : '';
    const visible = selector => qVisible([selector], root).length > 0;
    const captchaElement = visible('[class*=yidun]') || visible('.yidun_popup') || visible('#captcha')
      || visible('[class*=captcha]') || visible('[class*=slide-verify]') || visible('[class*=nc_iconfont]');
    const captchaText = /拖动滑块|滑动验证|请完成下方验证|拖动下方滑块|请完成安全验证/.test(text);
    const verify = /请输入短信验证码|短信验证码已发送|请输入邮箱验证码|请输入校验码/.test(text)
      || visible('input[placeholder*=验证码]');
    const wrongPassword = /账号或密码错误|帐号或密码错误|用户名或密码错误|密码错误|账号不存在/.test(text);
    const scan = visible('[class*=qrcode]') || visible('[class*=qr-code]') || visible('img[src*=qrcode]');
    return { captcha: captchaElement || captchaText, verify, wrongPassword, scan };
  `).catch(() => null)
  const issues = new Set()
  if (main?.captcha) issues.add('captcha')
  if (main?.verify) issues.add('verify')
  if (main?.scan) issues.add('scan')
  if (main?.wrongPassword) issues.add('password')

  // passport iframe 里也可能出现易盾滑块/短信验证；只认真实可见的容器
  if (!issues.size) {
    const frames = (await listFrames(page)).filter(frame => /reg\.icourse163\.org|passport/i.test(frame.url)).slice(0, 3)
    for (const frame of frames) {
      const flags = await frameRun(page, frame, `
        const text = document.body ? (document.body.innerText || '') : '';
        const visible = selector => qVisible([selector]).length > 0;
        return {
          captcha: visible('.yidun_popup') || visible('[class*=yidun]') || visible('#captcha')
            || visible('[class*=captcha]') || visible('[class*=slide-verify]') || visible('[class*=nc_iconfont]'),
          verify: /请输入短信验证码|短信验证码已发送/.test(text) || visible('input[placeholder*=短信验证码]'),
        };
      `).catch(() => null)
      if (flags?.captcha) { issues.add('captcha'); break }
      if (flags?.verify) { issues.add('verify') }
    }
  }
  if (issues.has('captcha')) return { needUser: 'captcha', message: '需要你手动完成滑块/安全验证：请在弹出的浏览器窗口里滑一下，完成后点「检查登录」' }
  if (issues.has('verify')) return { needUser: 'verify', message: '需要你手动完成手机/邮箱验证：请在浏览器窗口里填入收到的验证码，完成后点「检查登录」' }
  if (issues.has('scan')) return { needUser: 'scan', message: '当前是扫码登录：请在浏览器窗口里用手机扫码，完成后点「检查登录」' }
  if (issues.has('password')) return { needUser: 'password', message: '账号或密码不对，请在「账号与登录」里改好密码再试一次' }
  return { needUser: null, message: '' }
}

/**
 * 检查登录状态。综合三路信号：Cookie（CDP 能看到 HttpOnly）、页面 DOM、用户信息接口。
 * 未登录时该接口返回 result:null（已实测），登录后返回带昵称的对象。
 */
export async function checkLogin(page) {
  let cookies = []
  try { cookies = await page.cookies('icourse163.org').catch(() => []) } catch (error) { cookies = [] }
  // 只认 icourse163.org 及其子域的 Cookie：.icourse163.com / .icourse163.cn 上也可能有同名的
  // STUDY_SESS/STUDY_INFO（历史遗留或关联站点），拿它们判断会误判成「已登录」。
  const originCookies = (Array.isArray(cookies) ? cookies : []).filter(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '')
    return domain === 'icourse163.org' || domain.endsWith('.icourse163.org')
  })
  const cookieNames = new Set(originCookies.map(item => String(item?.name || '')).filter(Boolean))
  const hasLoginCookie = LOGIN_COOKIE_NAMES.some(name => cookieNames.has(name))

  const info = await runAsync(page, `
    const text = document.body ? (document.body.innerText || '') : '';
    const navLogin = q('.navLoginBtn');
    const navLoginVisible = Boolean(navLogin) && isVisible(navLogin) && /登录/.test(textOf(navLogin));
    const userNumber = qVisible(['[class*=avatar]', '[class*=userName]', '[class*=user-name]', '[class*=nickname]', '[class*=nickName]', '[class*=userCenter]', '[class*=userInfo]']).length;
    const hasMyCourse = qa('a,div,span').some(el => /^我的课程$/.test(textOf(el)) && isVisible(el));
    let rpc = null;
    try {
      const csrf = (document.cookie.match(/NTESSTUDYSI=([^;]+)/) || [])[1] || '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(${JSON.stringify(URLS.userInfoRpc)} + (csrf ? ('?csrfKey=' + encodeURIComponent(csrf)) : ''), {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      rpc = await response.json();
    } catch (error) { rpc = null; }
    const result = rpc && rpc.result && typeof rpc.result === 'object' ? rpc.result : null;
    const user = result ? {
      name: norm(result.nickName || result.nickname || result.realName || result.userName || result.name || ''),
      email: norm(result.email || result.mail || ''),
    } : null;
    return { navLoginVisible, userNumber, hasMyCourse, rpcCode: rpc ? rpc.code : null, user, textHasLoginError: /账号或密码错误|帐号或密码错误/.test(text) };
  `).catch(() => null)

  const rpcUser = info?.user && (info.user.name || info.user.email) ? info.user : null
  const loggedIn = Boolean(hasLoginCookie || rpcUser || (info?.hasMyCourse && !info?.navLoginVisible) || (info?.userNumber > 0 && !info?.navLoginVisible))
  const issue = loggedIn ? { needUser: null, message: '' } : await detectLoginIssue(page).catch(() => ({ needUser: null, message: '' }))
  const name = rpcUser?.name || ''
  const email = rpcUser?.email || ''
  const message = loggedIn
    ? `已登录${name ? `，欢迎 ${name}` : ''}`
    : (issue.message || '还没有登录中国大学 MOOC')
  return {
    loggedIn,
    needUser: loggedIn ? null : issue.needUser,
    message,
    user: loggedIn && (name || email) ? { name, email } : null,
  }
}

/**
 * 完整登录：打开登录入口 → 填表 → 提交 → 轮询。
 * 一旦出现滑块/验证码/扫码/密码错误，立即把控制权交还用户（不卡死）。
 */
export async function login(page, account = {}, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const email = typeof account.email === 'string' ? account.email.trim() : ''
  const password = typeof account.password === 'string' ? account.password : ''
  if (!email || !password) throw new Error('登录失败：还没有账号或密码，请先在「账号与登录」里填好并保存')
  onProgress('open', '正在打开中国大学 MOOC 登录入口…')
  await openLogin(page, { categoryFirst: false })
  onProgress('fill', '正在填写账号和密码…')
  const filled = await fillLogin(page, { email, password })
  if (filled?.needSubmit !== false) {
    onProgress('submit', '正在提交登录…')
    await submitLogin(page)
  }
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    await sleep(1_200)
    try { last = await checkLogin(page) } catch (error) { last = null }
    if (last?.loggedIn) return last
    if (last?.needUser) {
      onProgress('need-user', last.message)
      return last
    }
  }
  return last || {
    loggedIn: false,
    needUser: null,
    message: '登录还没完成：请在浏览器窗口里完成验证，然后点「检查登录」',
    user: null,
  }
}

/** 等用户手动完成验证后，由 service 调用的轮询版本。 */
export async function waitLogin(page, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30_000
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const deadline = Date.now() + timeoutMs
  let last = { loggedIn: false, needUser: null, message: '还没有登录中国大学 MOOC', user: null }
  while (Date.now() < deadline) {
    try { last = await checkLogin(page) } catch (error) { /* 页面还在跳转，下一轮再看 */ }
    if (last?.loggedIn) {
      onProgress('done', last.message)
      return last
    }
    if (last?.needUser) onProgress('need-user', last.message)
    await sleep(1_500)
  }
  return last
}

// ---------------------------------------------------------------------------
// 课程列表
// ---------------------------------------------------------------------------

/** 注入到页面里的一段：从 DOM 里抓课程卡片。登录后的「我的课程」/公开首页都用它。 */
const EXTRACT_COURSES_BODY = String.raw`
  const parseProgress = text => {
    const percentMatch = text.match(/(\d{1,3})\s*%/);
    if (percentMatch) return Math.max(0, Math.min(1, Number(percentMatch[1]) / 100));
    const ratio = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:节|个单元|课时|讲|个)/);
    if (ratio && Number(ratio[2]) > 0) return Math.max(0, Math.min(1, Number(ratio[1]) / Number(ratio[2])));
    return null;
  };
  const courseIdFromUrl = url => {
    const match = String(url).match(/(?:spoc\/)?learn\/([A-Za-z0-9]+-\d+)/) || String(url).match(/(?:spoc\/)?course\/([A-Za-z0-9]+-\d+)/);
    if (match) return match[1];
    const tid = String(url).match(/[?&]tid=(\d+)/);
    if (tid) return 'tid-' + tid[1];
    return '';
  };
  const collectCourses = () => {
    const anchors = qa('a[href]').filter(isVisible).filter(el => /\/(?:spoc\/)?learn\//.test(el.getAttribute('href') || ''));
    const fallbackAnchors = anchors.length ? [] : qa('a[href]').filter(isVisible).filter(el => /\/course\//.test(el.getAttribute('href') || ''));
    const allAnchors = anchors.length ? anchors : fallbackAnchors;
    const seen = new Map();
    for (const anchor of allAnchors) {
      const href = absoluteUrl(anchor.getAttribute('href') || '');
      if (!href || !/icourse163\.org/.test(href)) continue;
      const id = courseIdFromUrl(href);
      if (!id || seen.has(id)) continue;
      // 从链接往上找一块「像课程卡片」的容器：文本 15~400 字、一路不跨到列表
      let container = anchor;
      let best = anchor;
      for (let depth = 0; depth < 8 && container && container.parentElement; depth += 1) {
        const parent = container.parentElement;
        const text = textOf(parent);
        if (text.length > 15 && text.length < 500) best = parent;
        if (parent.querySelectorAll('a[href]').length > 8) { container = parent; break; }
        container = parent;
      }
      const text = textOf(best);
      const title = firstText(['[class*=courseName]', '[class*=course-name]', '[class*=courseTitle]', '[class*=course-title]', '[class*=title]', '[class*=name]', 'h1', 'h2', 'h3', 'h4', 'strong'], best)
        || textOf(anchor)
        || text.split(/[。\n]/)[0];
      const lines = (best.innerText || '').split(/\n+/).map(norm).filter(Boolean);
      const teacher = firstText(['[class*=teacher]', '[class*=lector]', '[class*=Teacher]'], best)
        || (lines.find(line => /^(老师|教师|讲师)[:：]?\s*\S{2,}/.test(line)) || '').replace(/^(老师|教师|讲师)[:：]?\s*/, '')
        || (lines.find(line => /老师$|教授$|讲师$/.test(line)) || '');
      const term = firstText(['[class*=term]', '[class*=Term]', '[class*=semester]'], best)
        || (text.match(/第\s*\d+\s*次开课/) || [''])[0]
        || (text.match(/20\d{2}\s*年[^，,；;]{0,12}/) || [''])[0];
      const school = firstText(['[class*=school]', '[class*=School]', '[class*=university]'], best)
        || (lines.find(line => /大学$|学院$|学校$|大学\s/.test(line) && line.length <= 30) || '');
      const state = (text.match(/进行中|已结束|即将开始|已完结|未开始|已关闭/) || [''])[0];
      const img = q('img', best);
      const cover = img ? absoluteUrl(img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      const spoc = /\/spoc\//.test(href) || /spoc/i.test(href) || /SPOC/.test(text);
      seen.set(id, {
        id,
        title: norm(title).slice(0, 200),
        teacher: norm(teacher).slice(0, 120),
        term: norm(term).slice(0, 80),
        cover,
        url: href,
        spoc,
        state: norm(state).slice(0, 40),
        progress: parseProgress(text),
        school: norm(school).slice(0, 120),
      });
    }
    return Array.from(seen.values());
  };
`

/** 登录后的「我的课程」页面（未登录会被重定向到错误页）。 */
export async function readMyCourses(page, opts = {}) {
  // 课程列表走站点自己的 RPC（MOOC / SPOC 都能读到），不再猜 DOM。
  return web.readMyCourses(page, opts)
}

// ---------------------------------------------------------------------------
// 章节大纲
// ---------------------------------------------------------------------------

/** 把课程地址换成学习页地址（SPOC 走 /spoc/learn/）。 */
function toLearnUrl(course) {
  const id = clean(course?.id, 120)
  const raw = clean(course?.url, 800)
  if (!raw) {
    if (!id) return ''
    return course?.spoc ? `${URLS.spocLearn}${id}` : `${URLS.learn}${id}`
  }
  const hashIndex = raw.indexOf('#')
  const main = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  if (/\/learn\//.test(main)) return raw
  const tidMatch = main.match(/[?&]tid=(\d+)/)
  const tid = tidMatch ? `?tid=${tidMatch[1]}` : ''
  const idMatch = main.match(/(?:\/spoc)?\/course\/([A-Za-z0-9]+-\d+)/)
  if (idMatch) {
    return /\/spoc\//.test(main)
      ? `${URLS.spocLearn}${idMatch[1]}${tid}`
      : `${URLS.learn}${idMatch[1]}${tid}`
  }
  return main
}

/** 注入脚本：从学习页左侧章节菜单（或类似结构）抽章节 + 单元。 */
const EXTRACT_OUTLINE_BODY = String.raw`
  const metaFromText = text => {
    const durationMatch = text.match(/\b(\d{1,3}(?::\d{2}){1,2})\b/) || text.match(/(\d{1,3})\s*分钟/);
    const deadlineMatch = text.match(/(?:截止|截止时间|deadline)[:：\s]*([^，,；;\n]{2,30})/i)
      || text.match(/(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s*\d{1,2}:\d{2})?)/);
    const statusMatch = text.match(/已完成|未完成|未开始|进行中|待完成|待提交|已过期|已关闭|已批改|已提交|已发布/);
    const scoreMatch = text.match(/(?:得分|成绩|分数)[:：\s]*(\d+(?:\.\d+)?)\s*分?/);
    return {
      duration: durationMatch ? norm(durationMatch[0]) : '',
      deadline: deadlineMatch ? norm(deadlineMatch[1] || deadlineMatch[0]) : '',
      status: statusMatch ? statusMatch[0] : '',
      score: scoreMatch ? norm(scoreMatch[1]) + ' 分' : '',
    };
  };
  const kindFromElement = (el, text, href) => {
    const hint = [
      String(el.className || ''),
      String(el.getAttribute('data-type') || ''),
      String(el.getAttribute('data-kind') || ''),
      String(el.getAttribute('href') || ''),
      textOf(q('[class*=icon],[class*=Icon],i,svg', el) || el),
    ].join(' ');
    const typeParam = (href.match(/[?&#]type=([a-z]+)/i) || [])[1] || '';
    const combined = hint + ' ' + typeParam + ' ' + text + ' ' + href;
    if (/考试|期末考|期中|exam|final/i.test(combined)) return 'exam';
    if (/测验|测试|随堂测|quiz|test/i.test(combined)) return 'quiz';
    if (/作业|编程题|编程练习|homework|assignment/i.test(combined)) return 'homework';
    if (/讨论|话题|交流|discussion|forum|bbs/i.test(combined)) return 'discussion';
    if (/视频|课时|lecture|video|播放/i.test(combined)) return 'video';
    if (/文档|课件|讲义|阅读|pdf|doc|reading/i.test(combined)) return 'doc';
    if (/测验|测试|quiz/i.test(text)) return 'quiz';
    return 'other';
  };
  const unitFromElement = (el, index) => {
    const anchor = el.tagName === 'A' ? el : q('a[href]', el);
    const href = anchor ? absoluteUrl(anchor.getAttribute('href') || '') : '';
    const text = textOf(el);
    const title = firstText(['[class*=name]', '[class*=title]', '[class*=unitName]', '[class*=sectionName]', 'span', 'a'], el) || norm(anchor ? textOf(anchor) : text);
    const dataId = el.getAttribute('data-id') || el.id || (anchor ? anchor.getAttribute('data-id') : '') || '';
    const meta = metaFromText(text);
    const kind = kindFromElement(el, text, href);
    return {
      id: String(dataId || '').trim() || ('unit-' + (index + 1)),
      title: title.slice(0, 200),
      kind,
      url: href,
      duration: meta.duration,
      deadline: meta.deadline,
      status: meta.status,
      score: meta.score,
    };
  };
  const isHeading = el => {
    const text = textOf(el);
    if (!text || text.length > 80) return false;
    return /^(第\s*[一二三四五六七八九十百\d]+\s*[章周讲单元]|Chapter\s*\d+|Unit\s*\d+|第\s*\d+\s*部分)/i.test(text);
  };
  const collectOutline = () => {
    const chapters = [];
    // 方案 A：先找章节标题，再收它后面同一容器里的单元
    const headingCandidates = qa('div,span,a,li,h1,h2,h3,h4,h5,h6').filter(isVisible).filter(isHeading);
    const headings = headingCandidates.filter(el => !headingCandidates.some(other => other !== el && el.contains(other)));
    if (headings.length) {
      for (const heading of headings) {
        const title = textOf(heading);
        let container = heading.parentElement;
        let best = heading.parentElement;
        for (let depth = 0; depth < 5 && container; depth += 1) {
          const count = qa('a[href],[class*=item],[class*=unit],[class*=lesson],[class*=section]', container).filter(isVisible).length;
          if (count >= 1) { best = container; break; }
          container = container.parentElement;
        }
        if (!best) best = heading.parentElement;
        const unitNodes = qa('a[href],[class*=item],[class*=unit],[class*=lesson],[class*=section]', best)
          .filter(isVisible)
          .filter(el => el !== heading && !el.contains(heading) && !heading.contains(el))
          .filter(el => {
            const text = textOf(el);
            return text.length >= 1 && text.length <= 200;
          });
        // 去掉互相包含的重复项，保留最内层
        const units = unitNodes.filter(el => !unitNodes.some(other => other !== el && el.contains(other))).map(unitFromElement);
        if (!units.length) continue;
        chapters.push({
          id: heading.getAttribute('data-id') || heading.id || ('chapter-' + (chapters.length + 1)),
          index: chapters.length + 1,
          title: title.slice(0, 200),
          units: units.filter(unit => unit.title),
        });
      }
    }
    // 方案 B：没有「第X章」标题时，按 class 含 chapter/catalog 的容器分组
    if (!chapters.length) {
      const containers = qa('[class*=chapter],[class*=Chapter],[class*=catalogue],[class*=catalog],[class*=outline],[class*=Outline],[class*=menu],[class*=Menu],[class*=section]')
        .filter(isVisible)
        .filter(el => {
          const text = textOf(el);
          if (text.length < 10) return false;
          const unitCount = qa('a[href],[class*=item],[class*=unit],[class*=lesson]', el).filter(isVisible).length;
          return unitCount >= 2 && unitCount <= 200;
        });
      const top = containers.filter(el => !containers.some(other => other !== el && other.contains(el)));
      for (const container of top) {
        const groupNodes = qa('[class*=chapter],[class*=section],[class*=unitGroup],[class*=itemGroup],[class*=catalogItem]', container).filter(isVisible);
        const groups = groupNodes.length ? groupNodes : [container];
        for (const group of groups) {
          const title = firstText(['[class*=title]', '[class*=name]', 'h1', 'h2', 'h3', 'h4', 'strong', 'span'], group)
            || ('第 ' + (chapters.length + 1) + ' 章');
          const unitNodes = qa('a[href],[class*=item],[class*=unit],[class*=lesson]', group).filter(isVisible);
          const units = unitNodes
            .filter(el => el !== group)
            .filter(el => !unitNodes.some(other => other !== el && el.contains(other)))
            .map(unitFromElement)
            .filter(unit => unit.title);
          if (units.length) {
            chapters.push({
              id: group.getAttribute('data-id') || group.id || ('chapter-' + (chapters.length + 1)),
              index: chapters.length + 1,
              title: title.slice(0, 200),
              units,
            });
          }
        }
      }
    }
    return chapters;
  };
`

/** 公开课程详情页的「课程大纲」富文本兜底（没有单元链接，仅用来给用户看结构）。 */
const EXTRACT_PUBLIC_OUTLINE_BODY = String.raw`
  function kindFromText(value) {
    if (/考试|期末考|期中/.test(value)) return 'exam';
    if (/测验|测试|小测/.test(value)) return 'quiz';
    if (/作业|练习|编程题/.test(value)) return 'homework';
    if (/讨论|话题/.test(value)) return 'discussion';
    if (/视频|课时|讲/.test(value)) return 'video';
    if (/文档|课件|阅读|材料/.test(value)) return 'doc';
    return 'other';
  }
  const collectPublicOutline = () => {
    // 按优先级找「课程大纲」区域：课程概述等其它富文本不能算
    let box = null;
    for (const selector of ['.outlineBody', '[class*=outlineBody]', '.outline .f-richEditorText', '[class*=outline] .f-richEditorText']) {
      const found = q(selector);
      if (found && textOf(found).length > 20) { box = found; break; }
    }
    if (!box) {
      for (const candidate of qa('.f-richEditorText,[class*=richEditor],[class*=outline]')) {
        const content = textOf(candidate);
        if (/第\s*[一二三四五六七八九十百\d]+\s*[周章]/.test(content)) { box = candidate; break; }
      }
    }
    if (!box) return [];
    const paragraphs = qa('p,li,div', box).filter(el => {
      const text = textOf(el);
      return text && text.length <= 200 && !el.querySelector('p,li,div');
    });
    if (!paragraphs.length) return [];
    const chapters = [];
    let current = null;
    let headingSeen = false;
    for (const paragraph of paragraphs) {
      const text = textOf(paragraph);
      const span = q('span', paragraph);
      const fontSize = span ? parseFloat(getComputedStyle(span).fontSize) : 0;
      // 「第1周编程练习」不是章节标题，是这周下面的作业
      const looksLikeExercise = /练习|作业|测验|测试|考试|讨论/.test(text);
      const isChapterTitle = !looksLikeExercise
        && (/^(第\s*[一二三四五六七八九十百\d]+\s*[章周讲单元]|Chapter\s*\d+)/i.test(text) || fontSize >= 15);
      if (isChapterTitle) {
        headingSeen = true;
        current = { id: 'chapter-' + (chapters.length + 1), index: chapters.length + 1, title: text.slice(0, 200), units: [] };
        chapters.push(current);
        continue;
      }
      if (!current) {
        current = { id: 'chapter-1', index: 1, title: '课程大纲', units: [] };
        chapters.push(current);
      }
      let kind = kindFromText(text);
      // 公开大纲里没有类型信息：像「1 计算机和编程语言」这种编号条目基本是课时视频
      if (kind === 'other' && /^\d+[.、)．\s]/.test(text)) kind = 'video';
      current.units.push({
        id: 'unit-' + current.index + '-' + (current.units.length + 1),
        title: text.slice(0, 200),
        kind,
        url: '',
        duration: '',
        deadline: '',
        status: '',
        score: '',
      });
    }
    // 没认出一个章节标题，说明这多半不是大纲富文本，别拿课程简介糊弄人
    if (!headingSeen) return [];
    return chapters.filter(chapter => chapter.units.length);
  };
`

/** 打开课程学习页并读取章节大纲；学习页打不开时退回公开课程详情页的大纲文本。 */
export async function readOutline(page, course) {
  // 新版 MOOC（/mooc/learn/...）和 SPOC 老 SPA 结构完全不同，交给 mooc-web.mjs 统一处理。
  return web.readOutline(page, course)
}

/** 老 SPA 的章节大纲（历史页面兜底用）。 */
export async function readOutlineLegacy(page, course) {
  const courseId = clean(course?.id, 120)
  if (!courseId && !course?.url) throw new Error('读取章节大纲失败：没有课程 id 或课程地址')
  const learnUrl = toLearnUrl(course || {})
  if (!learnUrl) throw new Error(`读取章节大纲失败：拼不出「${clean(course?.title, 80) || courseId}」的学习页地址`)
  await page.goto(learnUrl, { waitMs: 3_200 })
  let current = ''
  try { current = String(await page.url()) } catch (error) { current = '' }
  if (/\/error\//.test(current)) {
    throw await fail(page, `打开「${clean(course?.title, 80) || courseId}」的学习页失败：可能需要先选课，或者登录已经失效`)
  }
  // 页面可能还在加载章节，最多等 10 秒
  const deadline = Date.now() + 10_000
  let chapters = []
  while (Date.now() < deadline) {
    chapters = await run(page, `${EXTRACT_OUTLINE_BODY}\nreturn collectOutline();`).catch(() => [])
    if (Array.isArray(chapters) && chapters.length) break
    await sleep(1_000)
  }
  let source = 'dom'
  if (!Array.isArray(chapters) || !chapters.length) {
    // 学习页读不到（例如被重定向到课程介绍页）时，用公开大纲富文本兜底
    await page.goto(toLearnUrl(course) , { waitMs: 2_000 }).catch(() => {})
    const publicChapters = await run(page, `${EXTRACT_PUBLIC_OUTLINE_BODY}\nreturn collectPublicOutline();`).catch(() => [])
    if (Array.isArray(publicChapters) && publicChapters.length) {
      chapters = publicChapters
      source = 'mixed'
    }
  }
  if (!Array.isArray(chapters) || !chapters.length) {
    throw await fail(page, '没有在课程页面上找到章节大纲：可能课程还没开始、需要先选课，或者左侧章节菜单的结构变了')
  }
  const cleaned = chapters.map((chapter, index) => ({
    id: clean(chapter.id, 120) || `${courseId}:chapter:${index + 1}`,
    index: index + 1,
    title: clean(chapter.title, 200) || `第 ${index + 1} 章`,
    units: (Array.isArray(chapter.units) ? chapter.units : [])
      .map((unit, unitIndex) => ({
        id: clean(unit.id, 160) || `${courseId}:unit:${index + 1}:${unitIndex + 1}`,
        title: clean(unit.title, 200) || `单元 ${unitIndex + 1}`,
        kind: normalizeKind(unit.kind, unit.title, unit.url),
        url: clean(unit.url, 800),
        duration: clean(unit.duration, 60),
        deadline: clean(unit.deadline, 80),
        status: clean(unit.status, 60),
        score: clean(unit.score, 60),
      }))
      .filter(unit => Boolean(unit.title || unit.url)),
  })).filter(chapter => chapter.units.length)
  if (!cleaned.length) {
    throw await fail(page, '读到了章节标题，但没有找到任何可执行的单元（视频/测验/作业/考试/讨论）')
  }
  return {
    courseId,
    fetchedAt: new Date().toISOString(),
    source,
    chapters: cleaned,
  }
}

// ---------------------------------------------------------------------------
// 视频
// ---------------------------------------------------------------------------

/** 找当前页面（含 iframe）里正在播放的 <video>，返回一个可反复调用的控制上下文。 */
async function findVideoContext(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const main = await run(page, `
      const video = document.querySelector('video');
      return video ? { found: true, src: video.currentSrc || video.src || '' } : { found: false };
    `).catch(() => null)
    if (main?.found) {
      return {
        eval: expression => page.eval(expression),
        label: '主页面',
      }
    }
    const frames = (await listFrames(page)).filter(frame => frame.depth >= 1)
    for (const frame of frames) {
      const found = await frameRun(page, frame, `return Boolean(document.querySelector('video'));`).catch(() => false)
      if (found) {
        return {
          eval: expression => frameEval(page, frame, expression),
          label: `iframe(${frame.url.split('?')[0].split('/').pop()})`,
        }
      }
    }
    await sleep(800)
  }
  return null
}

function videoControlBody(speed, muted) {
  return `(() => { ${DOM_HELPERS}
    const video = document.querySelector('video');
    if (!video) return { found: false };
    try { if (Math.abs(video.playbackRate - ${JSON.stringify(speed)}) > 0.05) video.playbackRate = ${JSON.stringify(speed)}; } catch (error) {}
    try { video.muted = ${muted ? 'true' : 'false'}; } catch (error) {}
    if (!video.ended && video.paused) {
      try { const promise = video.play(); if (promise && typeof promise.catch === 'function') promise.catch(() => {}); } catch (error) {}
    }
    return {
      found: true,
      ended: Boolean(video.ended),
      paused: Boolean(video.paused),
      current: Number(video.currentTime) || 0,
      duration: Number(video.duration) || 0,
      readyState: Number(video.readyState) || 0,
    };
  })()`
}

/** 读视频字幕：优先 textTracks 的 cue，其次页面上的字幕/逐字稿区域。 */
async function readVideoTranscript(page, context) {
  const body = `(() => { ${DOM_HELPERS}
    const pieces = [];
    const video = document.querySelector('video');
    if (video && video.textTracks) {
      for (const track of Array.from(video.textTracks)) {
        try {
          for (const cue of Array.from(track.cues || [])) {
            const text = norm(cue.text || '');
            if (text) pieces.push(text);
          }
        } catch (error) {}
      }
    }
    for (const el of qa('[class*=subtitle],[class*=Subtitle],[class*=transcript],[class*=Transcript],[class*=caption],[class*=zmu],[class*=zimu],[class*=lectureText]')) {
      if (!isVisible(el)) continue;
      const text = textOf(el);
      if (text.length > 20) pieces.push(text);
    }
    return unique(pieces).join('\\n').slice(0, 20_000);
  })()`
  try {
    const text = await context.eval(body)
    return typeof text === 'string' ? text : ''
  } catch (error) {
    return ''
  }
}

/**
 * 认真上完一节视频课：打开单元 → 找 <video> → 按 speed 倍速播放 → 每 1.5 秒回调进度。
 * 暂停会自动恢复播放；播放结束或进度 >= 99% 视为完成。
 */
export async function playVideoUnit(page, unit, opts = {}) {
  // 新版 MOOC 播放器（/mooc/learn/...）结构不同，交给 mooc-web.mjs。
  if (web.isNewUnit(unit)) return web.playVideoUnit(page, unit, opts)
  const speed = Math.min(4, Math.max(0.5, Number(opts.speed) > 0 ? Number(opts.speed) : 2))
  const muted = opts.muted === true
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : () => {}
  const signal = opts.signal
  const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : 4 * 60 * 60 * 1_000
  const title = clean(unit?.title, 200) || '视频课时'

  await enterUnit(page, unit)
  if (signal?.aborted) return { completed: false, watchedSeconds: 0, durationSeconds: 0, transcript: '', message: '已取消播放' }
  let context = await findVideoContext(page, 30_000)
  if (!context) {
    throw await fail(page, `打开「${title}」后没有找到 <video> 元素：可能这节课不是视频，或者播放器结构变了`)
  }
  const startedAt = Date.now()
  let deadline = startedAt + maxWaitMs
  let durationSeconds = 0
  let watchedSeconds = 0
  let bestPercent = 0
  let completed = false
  let lastMessage = '正在准备播放…'
  onTick({ percent: 0, message: lastMessage, watchedSeconds: 0, durationSeconds: 0 })

  while (true) {
    if (signal?.aborted) {
      return { completed: false, watchedSeconds, durationSeconds, transcript: '', message: '已取消播放' }
    }
    if (Date.now() > deadline) {
      lastMessage = `看了 ${Math.round(bestPercent)}%，但等太久了，先停在这里`
      break
    }
    let status = null
    try {
      status = await context.eval(videoControlBody(speed, muted))
    } catch (error) {
      status = null
    }
    if (!status?.found) {
      // 视频可能被页面切换/自动跳转；再找一次
      const again = await findVideoContext(page, 8_000)
      if (again) { context = again; continue }
      const text = await page.text().catch(() => '')
      if (/已完成|下一节|下一个|恭喜|学完|播放结束/.test(text) && bestPercent >= 85) {
        completed = true
        lastMessage = '视频播放结束'
      } else {
        lastMessage = '页面上的视频不见了，可能已经自动跳到下一节'
      }
      break
    }
    watchedSeconds = Number(status.current) || 0
    durationSeconds = Number(status.duration) > 0 ? Number(status.duration) : durationSeconds
    if (durationSeconds > 0) {
      const percent = Math.min(99, Math.round((watchedSeconds / durationSeconds) * 100))
      if (percent > bestPercent) bestPercent = percent
      // 按剩余时长 × 倍速安排截止时间，避免电影级时长把任务卡住
      const remainMs = Math.max(60_000, ((durationSeconds - watchedSeconds) / speed) * 1_000 + 90_000)
      if (startedAt + remainMs < deadline) deadline = startedAt + remainMs
    }
    lastMessage = durationSeconds > 0
      ? `正在播放：${bestPercent}%（${Math.floor(watchedSeconds / 60)}:${String(Math.floor(watchedSeconds % 60)).padStart(2, '0')} / ${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, '0')}）`
      : '正在播放视频…'
    onTick({ percent: bestPercent, message: lastMessage, watchedSeconds, durationSeconds })
    if (status.ended || (durationSeconds > 0 && watchedSeconds >= durationSeconds - 1.5) || bestPercent >= 99) {
      completed = true
      lastMessage = '这一节视频看完了'
      onTick({ percent: 100, message: lastMessage, watchedSeconds, durationSeconds })
      break
    }
    await sleep(1_500)
  }

  const transcript = await readVideoTranscript(page, context).catch(() => '')
  return {
    completed,
    watchedSeconds,
    durationSeconds,
    transcript,
    message: completed
      ? `「${title}」播放完成${transcript ? '，已读到字幕' : '（本页没有可用字幕）'}`
      : lastMessage,
  }
}

// ---------------------------------------------------------------------------
// 进入单元 / 测验 / 作业 / 考试
// ---------------------------------------------------------------------------

/** 打开或点击进入某个单元。有 url 就直接打开，没有就按标题在页面上点。 */
export async function enterUnit(page, unit) {
  const title = clean(unit?.title, 200) || '这个单元'
  const url = clean(unit?.url, 800)
  const clickSelector = clean(unit?.clickSelector, 400)
  const clickText = clean(unit?.clickText, 200)
  const clickScript = typeof unit?.clickScript === 'string' ? unit.clickScript : ''
  const learnUrl = clean(unit?.learnUrl, 800)
  const hasClickTarget = Boolean(clickSelector || clickScript || clickText)
  if (url && /^https?:\/\//i.test(url)) {
    await page.goto(url, { waitMs: 3_000 })
    const current = await page.url().catch(() => '')
    if (/\/error\//.test(current)) throw await fail(page, `打开「${title}」失败：地址跳到了错误页，可能需要重新登录或选课`)
    // 带点击目标的单元（老 SPA 的测试/考试/视频）打开列表页后还要再点一下
    if (clickSelector || clickScript) { /* 继续往下点 */ } else return
  } else if (hasClickTarget && learnUrl) {
    // 老 SPA 的单元没有固定地址：先确保在学习页，再按 data-cid / 标题点进去
    const current = String(await page.url().catch(() => '') || '')
    if (!current.includes(learnUrl.split('#')[0])) {
      await page.goto(learnUrl, { waitMs: 3_200 })
      await sleep(1_200)
    }
  }
  if (clickSelector) {
    let clicked = await page.click(clickSelector).then(() => true).catch(() => false)
    if (!clicked && learnUrl) {
      await page.goto(learnUrl, { waitMs: 3_200 }).catch(() => {})
      await sleep(1_500)
      clicked = await page.click(clickSelector).then(() => true).catch(() => false)
    }
    if (clicked) { await sleep(2_500); return }
  }
  if (clickScript) {
    let clicked = await page.eval(`(() => { ${clickScript} })()`).catch(() => false)
    if (!clicked && learnUrl) {
      await page.goto(learnUrl, { waitMs: 3_200 }).catch(() => {})
      await sleep(1_500)
      clicked = await page.eval(`(() => { ${clickScript} })()`).catch(() => false)
    }
    if (clicked) { await sleep(2_800); return }
  }
  const clicked = await page.clickText(clickText || title, { timeoutMs: 8_000 }).catch(() => false)
  if (!clicked) {
    throw await fail(page, `没有找到「${title}」的入口：当前页面不是课程学习页，请先刷新章节大纲`)
  }
  await sleep(2_500)
}

/**
 * 有「开始答题 / 开始测验 / 开始考试」按钮就点，并处理二次确认。
 * 已经在答题页或按钮不存在时不报错。
 */
export async function beginAttempt(page) {
  const labels = ['开始答题', '开始测验', '开始考试', '开始我的考试', '继续答题', '进入答题', '重新答题', '开始重做', '开始做题', '参加考试', '进入考试', '开始测试']
  // 有的页面要先勾「我已阅读并同意」
  await run(page, `
    for (const box of qa('input[type=checkbox]').filter(isVisible)) {
      const labelText = textOf(box.closest('label,div') || box);
      if (/同意|承诺|已阅读/.test(labelText) && !box.checked) { clickEl(box); }
    }
    return true;
  `).catch(() => false)
  for (const label of labels) {
    const clicked = await page.clickText(label, { timeoutMs: 1_500 }).catch(() => false)
    if (!clicked) continue
    await sleep(1_000)
    // 常见二次确认弹窗
    await run(page, `
      const dialog = closestDialog();
      if (!dialog) return false;
      for (const text of ['确定', '确认', '继续', '开始答题', '开始考试', '交卷', '继续答题']) {
        const button = qa('button,a,span,div', dialog).filter(isVisible).find(el => textOf(el) === text);
        if (button) return clickEl(button);
      }
      return false;
    `).catch(() => false)
    await sleep(1_800)
    return
  }
}

/** 注入脚本：把页面上的题目抽出来（同时保留 DOM 引用，供 applyAnswers 用）。 */
const QUESTION_HELPERS = String.raw`
  const optionKeyOf = (el, index) => {
    const input = q('input[type=radio],input[type=checkbox]', el);
    const value = input ? String(input.value || '') : '';
    if (/^[A-Za-z]$/.test(value)) return value.toUpperCase();
    const text = textOf(el);
    const match = text.match(/^([A-Za-z])[.、)．\s]/);
    if (match) return match[1].toUpperCase();
    return String.fromCharCode(65 + index);
  };
  const collectOptions = container => {
    const raw = [];
    for (const label of qa('label', container)) {
      if (q('input[type=radio],input[type=checkbox]', label)) raw.push(label);
    }
    if (!raw.length) {
      for (const el of qa('[class*=option],[class*=choice],[class*=select-item],[class*=answer-item],[class*=answerItem],[class*=item]', container)) {
        if (q('input[type=radio],input[type=checkbox]', el) || /^([A-Za-z][.、)．\s])/.test(textOf(el))) raw.push(el);
      }
    }
    if (!raw.length) {
      for (const li of qa('li', container)) {
        if (/^[A-Za-z][.、)．\s]/.test(textOf(li))) raw.push(li);
      }
    }
    const options = [];
    const seen = new Set();
    for (const el of raw) {
      if (!isVisible(el) && !q('input', el)) continue;
      const text = textOf(el);
      if (!text || text.length > 500) continue;
      const label = text.replace(/^[A-Za-z][.、)．\s]+/, '').trim() || text;
      if (seen.has(label)) continue;
      seen.add(label);
      const input = q('input[type=radio],input[type=checkbox]', el);
      options.push({
        key: optionKeyOf(el, options.length),
        label,
        inputKind: input ? String(input.type) : null,
        el,
      });
    }
    return options;
  };
  const collectQuestions = () => {
    const selectors = ['[class*=question-item]', '[class*=questionItem]', '[class*=u-question]', '[class*=m-question]', '[class*=j-question]', '[class*=question]', '[class*=subject-item]', '[class*=timu]', '[class*=ti-item]'];
    let candidates = [];
    for (const selector of selectors) candidates.push(...qa(selector));
    candidates = candidates.filter(el => isVisible(el) && textOf(el).length > 2);
    // 去掉包含其它候选的外层，保留最内层的题目容器
    candidates = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
    // 去掉重复题干
    const seenStem = new Set();
    candidates = candidates.filter(el => {
      const stem = firstText(['[class*=stem]', '[class*=questionTitle]', '[class*=question-title]', '[class*=title]', '[class*=subject]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'], el) || textOf(el).slice(0, 120);
      const key = norm(stem).slice(0, 80);
      if (!key || seenStem.has(key)) return false;
      seenStem.add(key);
      return true;
    });
    if (!candidates.length) {
      // 退化方案：按 radio/checkbox 的 name 分组
      const groups = new Map();
      for (const input of qa('input[type=radio],input[type=checkbox]')) {
        if (!isVisible(input)) continue;
        const name = String(input.name || '');
        if (!name) continue;
        if (!groups.has(name)) groups.set(name, input.closest('div,li,section,form') || input.parentElement);
      }
      candidates = Array.from(groups.values()).filter(Boolean);
      if (!candidates.length) {
        for (const area of qa('textarea,[contenteditable=true]')) {
          if (isVisible(area)) candidates.push(area.closest('div,li,section,form') || area.parentElement);
        }
      }
    }
    const questions = [];
    candidates.forEach((container, index) => {
      if (!container) return;
      const options = collectOptions(container);
      const stem = firstText(['[class*=stem]', '[class*=questionTitle]', '[class*=question-title]', '[class*=title]', '[class*=subject]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'], container) || textOf(container).slice(0, 400);
      const allText = textOf(container);
      const hasCheckbox = options.some(option => option.inputKind === 'checkbox') || Boolean(q('input[type=checkbox]', container));
      const hasRadio = options.some(option => option.inputKind === 'radio') || Boolean(q('input[type=radio]', container));
      const textarea = q('textarea', container);
      const editable = q('[contenteditable=true]', container);
      const textInput = q('input[type=text],input:not([type=radio]):not([type=checkbox]):not([type=hidden])', container);
      let type = 'single';
      if (/判断题/.test(allText)) type = 'judge';
      else if (/多选题|不定项/.test(allText)) type = 'multiple';
      else if (/单选题/.test(allText)) type = 'single';
      else if (/填空题|填空/.test(allText)) type = 'fill';
      else if (/简答题|论述题|问答题|名词解释/.test(allText)) type = 'short';
      else if (hasCheckbox) type = 'multiple';
      else if (options.length === 2 && options.every(option => /正确|错误|对|错|是|否/.test(option.label))) type = 'judge';
      else if (!options.length && (textarea || editable)) type = 'short';
      else if (!options.length && textInput) type = 'fill';
      const inputKind = hasRadio ? 'radio' : hasCheckbox ? 'checkbox' : textarea ? 'textarea' : (textInput ? 'text' : null);
      questions.push({
        index: index + 1,
        type,
        stem: stem.slice(0, 1_500),
        options,
        inputKind,
        el: container,
      });
    });
    return questions;
  };
  const stripQuestions = list => list.map(item => ({
    index: item.index,
    type: item.type,
    stem: item.stem,
    options: item.options.map(option => ({ key: option.key, label: option.label })),
    inputKind: item.inputKind,
  }));
`

/** 找「题目所在上下文」：主框架或某个 iframe，谁抽到的题多就用谁。 */
async function findQuestionContext(page) {
  const contexts = [{ eval: expression => page.eval(expression), label: '主页面' }]
  for (const frame of (await listFrames(page)).filter(frame => frame.depth >= 1)) {
    contexts.push({ eval: expression => frameEval(page, frame, expression), label: `iframe(${frame.id.slice(0, 6)})` })
  }
  let best = null
  let bestCount = 0
  for (const context of contexts) {
    try {
      const info = await context.eval(`(() => { ${DOM_HELPERS}\n${QUESTION_HELPERS}\nreturn { count: collectQuestions().length, text: (document.body ? document.body.innerText : '').slice(0, 500) };\n})()`)
      const count = Number(info?.count) || 0
      if (count > bestCount) { best = context; bestCount = count }
    } catch (error) { /* 这个上下文没有题目 */ }
  }
  return best
}

/** 读题：题干、选项、题型、提交按钮文字。 */
export async function readQuestions(page, unit) {
  await beginAttempt(page).catch(() => {})
  await sleep(800)
  const context = await findQuestionContext(page)
  if (!context) {
    throw await fail(page, `「${clean(unit?.title, 120) || '这一页'}」上没有找到题目：可能还没开始答题，或者题目页结构变了`)
  }
  const info = await context.eval(`(() => { ${DOM_HELPERS}\n${QUESTION_HELPERS}
    const questions = stripQuestions(collectQuestions());
    const buttons = qa('button,a,input[type=submit],input[type=button],span').filter(isVisible);
    const submit = buttons.find(el => /^(提交|交卷|提交答案|保存并提交|确认提交|完成提交)$/.test(textOf(el) || el.value || ''));
    return {
      questions,
      submitLabel: submit ? (textOf(submit) || submit.value || '提交') : '提交',
      pageTitle: document.title || '',
      rawText: (document.body ? document.body.innerText : '').slice(0, 20_000),
    };
  })()`)
  return {
    questions: Array.isArray(info?.questions) ? info.questions : [],
    submitLabel: clean(info?.submitLabel, 40) || '提交',
    pageTitle: clean(info?.pageTitle, 200),
    rawText: typeof info?.rawText === 'string' ? info.rawText : '',
  }
}

/** 按 index 填答案；判断题的 'true'/'false' 会映射到「正确/错误（对/错）」选项。 */
export async function applyAnswers(page, answers = []) {
  const list = (Array.isArray(answers) ? answers : []).filter(answer => answer && Number.isFinite(Number(answer.index)))
  if (!list.length) return { applied: 0, missing: [] }
  const context = await findQuestionContext(page)
  if (!context) throw await fail(page, '填写答案失败：当前页面上找不到题目')
  const result = await context.eval(`(() => { ${DOM_HELPERS}\n${QUESTION_HELPERS}
    const answers = ${JSON.stringify(list)};
    const questions = collectQuestions();
    const missing = [];
    let applied = 0;
    const normalizeChoice = value => norm(value == null ? '' : value);
    const judgeTarget = value => {
      const text = normalizeChoice(value).toLowerCase();
      if (['true', 't', '正确', '对', '是', 'yes', 'y', '√', 'a正确'].includes(text)) return 'true';
      if (['false', 'f', '错误', '错', '否', 'no', 'n', '×', 'x', 'b错误'].includes(text)) return 'false';
      return '';
    };
    const pickJudge = (options, value) => {
      const target = judgeTarget(value);
      const yes = /正确|对|是|√/;
      const no = /错误|错|否|×/;
      if (target === 'true') return options.find(option => yes.test(option.label)) || options[0];
      if (target === 'false') return options.find(option => no.test(option.label)) || options[1] || options[0];
      return null;
    };
    const matchesOption = (option, value) => {
      const wanted = normalizeChoice(value);
      if (!wanted) return false;
      if (option.key.toUpperCase() === wanted.toUpperCase()) return true;
      const input = q('input', option.el);
      if (input && String(input.value || '').toUpperCase() === wanted.toUpperCase()) return true;
      const label = option.label;
      return label === wanted || label.includes(wanted) || wanted.includes(label);
    };
    for (const answer of answers) {
      const question = questions[Number(answer.index) - 1];
      if (!question) { missing.push(answer.index); continue; }
      const choiceList = Array.isArray(answer.choice) ? answer.choice : (answer.choice == null ? [] : [answer.choice]);
      let filled = false;
      if (choiceList.length && question.options.length) {
        for (const choice of choiceList) {
          let option = question.options.find(item => matchesOption(item, choice));
          if (!option) option = pickJudge(question.options, choice);
          if (!option) continue;
          const input = q('input[type=radio],input[type=checkbox]', option.el);
          if (input) { try { input.click(); } catch (error) { clickEl(option.el); } }
          else clickEl(option.el);
          filled = true;
        }
      }
      if (!filled && typeof answer.text === 'string' && answer.text.length) {
        const area = q('textarea', question.el);
        const editable = q('[contenteditable=true]', question.el);
        const input = q('input[type=text],input:not([type=radio]):not([type=checkbox]):not([type=hidden])', question.el);
        if (editable) { setEditable(editable, answer.text); filled = true; }
        else if (area) { setValue(area, answer.text); filled = true; }
        else if (input) { setValue(input, answer.text); filled = true; }
      }
      if (filled) applied += 1; else missing.push(answer.index);
    }
    return { applied, missing };
  })()`)
  const applied = Number(result?.applied) || 0
  const missing = Array.isArray(result?.missing) ? result.missing : []
  return { applied, missing }
}

/** 点提交，并处理「确定交卷？」之类的二次确认，然后判断是否提交成功。 */
export async function submitQuestions(page) {
  const context = await findQuestionContext(page) || { eval: expression => page.eval(expression), label: '主页面' }
  // 先把原生 confirm 顶掉，避免 CDP 卡在对话框上
  await page.eval('(() => { try { window.confirm = () => true; } catch (error) {} return true; })()').catch(() => false)
  const clicked = await context.eval(`(() => { ${DOM_HELPERS}
    const all = qa('button,a,input[type=submit],input[type=button],span,div').filter(isVisible);
    const exact = ['提交', '交卷', '提交答案', '保存并提交', '确认提交', '完成提交', '提交试卷'];
    for (const label of exact) {
      const button = all.find(el => (textOf(el) || el.value || '') === label);
      if (button && clickEl(button)) return { ok: true, label };
    }
    const loose = all.filter(el => /提交|交卷/.test(textOf(el) || el.value || '')).filter(el => !/取消|返回|保存草稿|上一步/.test(textOf(el)));
    if (loose.length && clickEl(loose[0])) return { ok: true, label: textOf(loose[0]) };
    return { ok: false };
  })()`)
  if (!clicked?.ok) throw await fail(page, '没有找到「提交 / 交卷」按钮：可能这一页不是答题页，或者按钮文字变了')
  await sleep(1_000)
  // 二次确认弹窗，最多点三次
  for (let round = 0; round < 3; round += 1) {
    const confirmed = await run(page, `
      const dialog = closestDialog();
      if (!dialog) return false;
      for (const label of ['确定', '确认', '继续', '继续提交', '交卷', '提交']) {
        const button = qa('button,a,span,div', dialog).filter(isVisible).find(el => textOf(el) === label);
        if (button) { clickEl(button); return true; }
      }
      return false;
    `).catch(() => false)
    if (!confirmed) break
    await sleep(1_000)
  }
  await sleep(1_500)
  let text = ''
  try { text = await page.text() } catch (error) { text = '' }
  const lowered = text.slice(0, 8_000)
  const ok = /提交成功|已提交|交卷成功|答案已保存|提交完成|已保存|你的答案已提交|已完成/.test(lowered)
    || !/未提交|提交答案/.test(lowered)
  return {
    ok,
    message: ok ? '已经点了提交' : '点了提交，但页面没有明确提示成功，请人工确认一下',
  }
}

/** 读测验/作业/考试成绩、满分与否、错题（有解析就读出来）。 */
export async function readQuizResult(page) {
  const parse = async evalIn => evalIn(`(() => { ${DOM_HELPERS}
    const text = (document.body ? document.body.innerText : '').slice(0, 20_000);
    const scorePatterns = [
      /本次得分[：:\s]*([0-9]+(?:\.[0-9]+)?)/,
      /我的得分[：:\s]*([0-9]+(?:\.[0-9]+)?)/,
      /得分[：:\s]*([0-9]+(?:\.[0-9]+)?)/,
      /成绩[：:\s]*([0-9]+(?:\.[0-9]+)?)/,
      /分数[：:\s]*([0-9]+(?:\.[0-9]+)?)/,
    ];
    let score = null;
    for (const pattern of scorePatterns) {
      const match = text.match(pattern);
      if (match) { score = Number(match[1]); break; }
    }
    let maxScore = null;
    const maxMatch = text.match(/(?:满分|总分|共)[：:\s]*([0-9]+(?:\.[0-9]+)?)\s*分?/) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*分\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*分/);
    if (maxMatch) maxScore = Number(maxMatch[2] || maxMatch[1]);
    const ratio = text.match(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/);
    if (ratio) {
      if (score == null) score = Number(ratio[1]);
      if (maxScore == null && Number(ratio[2]) > 0) maxScore = Number(ratio[2]);
    }
    const wrong = [];
    const seen = new Set();
    for (const el of qa('[class*=question],[class*=item],[class*=wrong],[class*=analysis],[class*=result]').filter(isVisible)) {
      const block = textOf(el);
      if (!block || block.length < 10 || block.length > 1_500) continue;
      const correctMatch = block.match(/(?:正确答案|参考答案|正确答案是)[：:\s]*([^\n；;]{1,80})/);
      if (!correctMatch) continue;
      const chosenMatch = block.match(/(?:我的答案|你的答案|我的选择|已选择|我的回答)[：:\s]*([^\n；;]{1,80})/);
      const correct = correctMatch[1].trim();
      const chosen = chosenMatch ? chosenMatch[1].trim() : '';
      const stem = norm(block.split(/正确答案|参考答案|我的答案|你的答案|我的选择/)[0]).slice(0, 200);
      const key = stem + '|' + correct;
      if (seen.has(key)) continue;
      seen.add(key);
      wrong.push({ index: wrong.length + 1, stem, chosen, correct });
      if (wrong.length >= 50) break;
    }
    return {
      score,
      maxScore,
      wrong,
      message: '',
      rawText: text,
      fullMark: score != null && maxScore != null ? score >= maxScore - 0.5 : false,
    };
  })()`)

  let result = await parse(expression => page.eval(expression)).catch(() => null)
  if (!result || result.score == null) {
    const context = await findQuestionContext(page)
    if (context) {
      const fromFrame = await parse(expression => context.eval(expression)).catch(() => null)
      if (fromFrame && (fromFrame.score != null || fromFrame.wrong.length)) result = fromFrame
    }
  }
  // 页面上还有「查看成绩 / 查看解析」就先点开再读一次
  if (!result || result.score == null) {
    const clicked = await page.clickText('查看成绩', { timeoutMs: 1_500 }).catch(() => false)
      || await page.clickText('查看解析', { timeoutMs: 1_500 }).catch(() => false)
      || await page.clickText('成绩详情', { timeoutMs: 1_500 }).catch(() => false)
    if (clicked) {
      await sleep(1_800)
      result = await parse(expression => page.eval(expression)).catch(() => result)
    }
  }
  const fallback = result || { score: null, maxScore: null, wrong: [], rawText: '' }
  const fullMark = fallback.score != null && fallback.maxScore != null
    ? fallback.score >= fallback.maxScore - 0.5
    : /满分|全部准确|全部正确|恭喜.*满分/.test(fallback.rawText || '')
  return {
    score: fallback.score ?? null,
    maxScore: fallback.maxScore ?? null,
    fullMark,
    wrong: Array.isArray(fallback.wrong) ? fallback.wrong : [],
    message: fallback.score != null
      ? `本次成绩 ${fallback.score}${fallback.maxScore != null ? ` / ${fallback.maxScore}` : ''}`
      : '页面上没有读到分数（可能成绩还没出，或者成绩在另一个页面）',
    rawText: fallback.rawText || '',
  }
}

// ---------------------------------------------------------------------------
// 讨论区
// ---------------------------------------------------------------------------

const FORUM_READY_BODY = `
  const text = document.body ? (document.body.innerText || '') : '';
  const hasButton = qVisible(['button,a,span,div']).some(el => /发表话题|发帖|发布话题|发表新帖|写话题|发起话题|发布/.test(textOf(el)) && textOf(el).length <= 12);
  const hasList = qVisible(['[class*=forum]', '[class*=topic]', '[class*=thread]', '[class*=post]', '[class*=discuss]']).length > 0;
  const hasText = /综合讨论区|全部话题|最新回复|讨论区/.test(text);
  return { ready: (hasButton && hasList) || (hasList && hasText) || (hasButton && hasText), hasButton, hasList, hasText };
`

async function forumReady(page) {
  const main = await run(page, FORUM_READY_BODY).catch(() => null)
  if (main?.ready) return true
  for (const frame of (await listFrames(page)).filter(frame => frame.depth >= 1)) {
    const info = await frameRun(page, frame, FORUM_READY_BODY).catch(() => null)
    if (info?.ready) return true
  }
  return false
}

/** 找到并打开课程「综合讨论区」。 */
export async function openForum(page, course) {
  const currentUrl = String(await page.url().catch(() => '') || '')
  if (web.isNewCourse(course) || /\/mooc\/learn\//.test(currentUrl)) return web.openForum(page, course)
  const courseTitle = clean(course?.title, 120) || '这门课'
  let current = ''
  try { current = String(page.url ? await page.url() : '') } catch (error) { current = '' }
  const learnUrl = toLearnUrl(course || {})
  // 如果当前不在该课程的学习页，先打开学习页
  if (!/\/learn\//.test(current) || (course?.id && !current.includes(String(course.id)))) {
    let target = learnUrl
    if (!target) {
      // 只有 id/title（exec 传进来的就是这样）：去「我的课程」里按 id/title 找链接
      const found = await findCourseUrl(page, course)
      target = found || ''
    }
    if (!target) throw await fail(page, `没有找到「${courseTitle}」的学习页地址：先刷新课程列表和大纲，或者手动打开课程`)
    await page.goto(target, { waitMs: 3_000 })
  }
  // 先看当前页是不是已经到讨论区了
  if (await forumReady(page)) return
  // 在学习页左侧菜单里点「讨论区 / 综合讨论区」
  const labels = ['综合讨论区', '讨论区', '课程讨论区', '讨论']
  for (const label of labels) {
    const clicked = await page.clickText(label, { timeoutMs: 1_800 }).catch(() => false)
    if (!clicked) continue
    await sleep(2_200)
    if (await forumReady(page)) return
  }
  // 直接试常见 hash 路由（实测新版 SPOC 讨论区是 #/learn/forumindex）
  const base = String(await page.url().catch(() => '')).split('#')[0]
  for (const hash of ['#/learn/forumindex', '#/learn/forum', '#/learn/discuss', '#/learn/community', '#/forum']) {
    try {
      await page.goto(base + hash, { waitMs: 2_500 })
      if (await forumReady(page)) return
    } catch (error) { /* 试下一个 */ }
  }
  throw await fail(page, `没有找到「${courseTitle}」的综合讨论区入口：可能这门课没开讨论区，或者课程页结构变了`)
}

/** 只有课程 id/title 时，从「我的课程」里解析出课程链接。 */
async function findCourseUrl(page, course) {
  const id = clean(course?.id, 120)
  const title = clean(course?.title, 120)
  if (!id && !title) return ''
  try {
    await page.goto(URLS.mycourse, { waitMs: 3_000 })
    const list = await run(page, `${EXTRACT_COURSES_BODY}\nreturn collectCourses();`).catch(() => [])
    if (!Array.isArray(list)) return ''
    const hit = list.find(item => item.id === id) || list.find(item => title && item.title && item.title.includes(title))
    if (hit?.url) return toLearnUrl({ ...hit, id: hit.id })
  } catch (error) { /* 打不开课程列表就算了 */ }
  if (id) return toLearnUrl({ id, spoc: false })
  return ''
}

/** 在讨论区发一个话题。 */
export async function postDiscussion(page, course, post = {}) {
  const currentUrl = String(await page.url().catch(() => '') || '')
  if (web.isNewCourse(course) || /\/mooc\/learn\//.test(currentUrl)) return web.postDiscussion(page, course, post)
  const title = clean(post?.title, 40)
  const content = String(post?.content ?? '').trim()
  if (!title) throw new Error('发帖失败：标题是空的')
  if (!content) throw new Error('发帖失败：正文是空的')
  if (!(await forumReady(page).catch(() => false))) await openForum(page, course || {})
  // 点发帖按钮（新版 SPOC 讨论区叫「发起主题」，老版还有其它叫法）
  const postLabels = ['发起主题', '发起话题', '发表话题', '发布话题', '发表新帖', '发帖', '写话题', '发表']
  let buttonClicked = false
  for (const label of postLabels) {
    const clicked = await page.clickText(label, { timeoutMs: 1_800 }).catch(() => false)
    if (!clicked) continue
    buttonClicked = true
    break
  }
  if (!buttonClicked) throw await fail(page, '发帖失败：没有找到「发起主题 / 发帖」按钮')
  // 有的版本按文字点不生效，直接点「发起主题」按钮本身
  if (!String(await page.url().catch(() => '')).includes('forumeasytopic')) {
    await run(page, `
      const btn = qa('.j-newTopicBtn').filter(isVisible)[0];
      if (btn) { clickEl(btn); return true; }
      return false;
    `).catch(() => false)
  }
  // 等「发起新主题」页面打开：SPA 会切到 #/learn/forumeasytopic，再异步渲染 Quill 编辑器
  let composeReady = false
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const info = await run(page, `
      return {
        editor: Boolean(qa('.ql-editor[contenteditable=true]').filter(isVisible)[0]),
        forumeasytopic: location.hash.includes('forumeasytopic'),
      };
    `).catch(() => null)
    if (info?.editor) { composeReady = true; break }
    await sleep(500)
  }
  if (!composeReady) throw await fail(page, '发帖失败：点了发帖按钮，但发帖页面没有打开（没找到标题/正文编辑框）')
  try { await page.activate() } catch { /* ignore */ }
  // 选版块：综合讨论区（不选会校验失败）。偶发渲染慢，重试几次并校验触发器的文字。
  const selectBoard = async () => {
    const triggerBody = `
      const trigger = qa('div.up.j-up').filter(isVisible)[0]
        || qa('div,span,a,button').filter(isVisible).find(el => textOf(el) === '请选择主题所属板块' && el.children.length <= 2);
      if (!trigger) return null;
      const rect = trigger.getBoundingClientRect();
      return { text: textOf(trigger), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    `
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await run(page, `return (() => { ${triggerBody} })();`).catch(() => null)
      if (state && /综合讨论区/.test(state.text || '')) return true
      if (!state?.rect) { await sleep(500); continue }
      // 用真实鼠标点开板块下拉（后台标签页里 JS click 偶尔不触发它的下拉逻辑）
      try { await page.activate() } catch { /* ignore */ }
      await page.realClickAt(state.rect.x + state.rect.width / 2, state.rect.y + state.rect.height / 2).catch(() => {})
      await sleep(900)
      const option = await run(page, `
        const options = qa('h4,li,div,span').filter(isVisible).filter(el => textOf(el) === '综合讨论区');
        const target = options[options.length - 1];
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      `).catch(() => null)
      if (option?.rect) {
        await page.realClickAt(option.rect.x + option.rect.width / 2, option.rect.y + option.rect.height / 2).catch(() => {})
        await sleep(700)
      }
    }
    return false
  }
  const boardSelected = await selectBoard()
  if (!boardSelected) throw await fail(page, '发帖失败：没有选上「综合讨论区」板块，请稍后重试。')
  // 找编辑区（可能在 iframe 里）
  const contexts = [{ eval: expression => page.eval(expression), label: '主页面' }]
  for (const frame of (await listFrames(page)).filter(frame => frame.depth >= 1)) {
    contexts.push({ eval: expression => frameEval(page, frame, expression), label: `iframe(${frame.id.slice(0, 6)})` })
  }
  let editorContext = null
  for (const context of contexts) {
    const info = await context.eval(`(() => { ${DOM_HELPERS}
      const editable = contentEditor();
      const titleInput = qa('input.j-textarea.inputtxt, input[name="inputtxt"], input[placeholder="请输入标题"]').filter(isVisible)[0];
      return { hasEditor: Boolean(editable), hasTitle: Boolean(titleInput) };
    })()`).catch(() => null)
    if (info?.hasEditor) { editorContext = context; break }
  }
  if (!editorContext) throw await fail(page, '发帖失败：点了发帖按钮，但没有找到标题/正文编辑框')
  const filled = await editorContext.eval(`(() => { ${DOM_HELPERS}
    const titleInput = qa('input.j-textarea.inputtxt, input[name="inputtxt"], input[placeholder="请输入标题"]').filter(isVisible)[0]
      || qa('input[type=text]').filter(isVisible).find(el => !/搜索/.test(el.getAttribute('aria-label') || ''));
    if (titleInput) setValue(titleInput, ${JSON.stringify(title)});
    const editor = contentEditor();
    if (!editor) return { ok: false, reason: 'no-editor' };
    if (editor.isContentEditable) {
      // Quill 用 execCommand/innerHTML 写进去以后，点发表时它的内部 model 可能是空的；
      // 这里只负责把编辑器滚到视口里，真正的正文用鼠标点进去 + CDP Input.insertText 输入。
      try { editor.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
      try { editor.focus({ preventScroll: true }); } catch (error) {}
      const rect = editor.getBoundingClientRect();
      return { ok: true, mode: 'cdp', hasTitle: Boolean(titleInput), editorTag: editor.tagName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }
    const done = setValue(editor, ${JSON.stringify(content)});
    return { ok: Boolean(done), mode: 'setValue', hasTitle: Boolean(titleInput), editorTag: editor.tagName };
  })()`)
  if (!filled?.ok) throw await fail(page, '发帖失败：正文编辑框没有写进去，可能富文本编辑器结构变了')
  if (filled.mode === 'cdp' && filled.rect) {
    // 先真正用鼠标点进 Quill 编辑区（后台标签页里直接 focus 容易落到 ql-clipboard），
    // 再用 CDP 真实键盘输入，Quill 才会同步自己的 model。
    try { await page.activate() } catch { /* ignore */ }
    const point = filled.rect
    await page.realClickAt(point.x + Math.min(point.width / 2, 160), point.y + Math.min(point.height / 2, 60)).catch(() => {})
    await sleep(250)
    const focused = await editorContext.eval(`(() => { ${DOM_HELPERS}
      const editor = contentEditor();
      const active = document.activeElement;
      return Boolean(editor && active && (active === editor || editor.contains(active) || active.isContentEditable));
    })()`).catch(() => false)
    if (focused) {
      await page.send('Input.insertText', { text: content }).catch(() => {})
      await sleep(400)
    }
  }
  // 发布前再确认一次板块（编辑器聚焦/Quill 重渲染偶尔会把板块重置）
  await selectBoard()
  if (filled.mode === 'cdp') {
    const written = await editorContext.eval(`(() => { ${DOM_HELPERS}
      const editor = contentEditor();
      return editor ? (editor.innerText || '') : '';
    })()`).catch(() => '')
    if (!String(written || '').includes(String(content).slice(0, 8))) {
      // 兜底：直接用 execCommand 再写一次
      await editorContext.eval(`(() => { ${DOM_HELPERS}
        const editor = contentEditor();
        if (editor) setEditable(editor, ${JSON.stringify(content)});
        return true;
      })()`).catch(() => false)
    }
  }
  await sleep(600)
  // 点发布
  await page.startNetwork().catch(() => {})
  const published = await run(page, `
    const direct = q('.j-publish');
    if (direct) { clickEl(direct); return { ok: true, label: 'j-publish' }; }
    const all = qa('button,a,input[type=submit],span,div').filter(isVisible);
    const labels = ['发布', '发表', '提交', '确认发布', '发布话题'];
    for (const label of labels) {
      const button = all.find(el => textOf(el) === label);
      if (button) { clickEl(button); return { ok: true, label }; }
    }
    return { ok: false };
  `).catch(() => null)
  if (!published?.ok) {
    // 试着在主框架点发布
    for (const label of ['发布', '发表', '提交']) {
      const clicked = await page.clickText(label, { timeoutMs: 1_500 }).catch(() => false)
      if (clicked) break
    }
  }
  await sleep(2_500)
  // 可能的确认框
  await run(page, `
    const dialog = closestDialog();
    if (!dialog) return false;
    for (const label of ['确定', '确认', '发布', '发表']) {
      const button = qa('button,a,span,div', dialog).filter(isVisible).find(el => textOf(el) === label);
      if (button) { clickEl(button); return true; }
    }
    return false;
  `).catch(() => false)
  await sleep(1_500)
  // 等页面给出结果：成功提示 / 回到论坛列表 / 跳到登录页
  let state = { url: '', text: '' }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    state = await run(page, `
      return { url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 20_000) };
    `).catch(() => ({ url: '', text: '' }))
    const success = /发表成功|发布成功|发布完成|已发布|提交成功/.test(state.text)
      || (state.url.includes('/forum') && !state.url.includes('forumeasytopic'))
    const loginWall = /登录\s*[|｜]\s*注册|请先登录|登录后才能|立即登录/.test(state.text)
      || /passport\.163\.com|reg\.163\.com/i.test(state.url)
    if (success || loginWall) break
    await sleep(500)
  }
  const afterText = state.text || ''
  const mainText = await page.text().catch(() => '')
  // 以发帖接口的结果为准：DWR addPost 返回 200 且没有异常，就认为发布成功
  const network = await page.takeNetwork({ filter: 'addPost' }).catch(() => [])
  await page.stopNetwork().catch(() => {})
  const publishCall = network.find(item => /addPost/i.test(item.url || ''))
  const netOk = Boolean(publishCall && publishCall.status >= 200 && publishCall.status < 400 && !/exception|error|失败|异常/i.test(publishCall.body || ''))
  const ok = netOk
    || /发表成功|发布成功|发布完成|已发布|提交成功/.test(afterText)
    || /发表成功|发布成功|已发布/.test(mainText)
    || (title && mainText.includes(title))
  if (!ok && (/登录\s*[|｜]\s*注册|请先登录|登录后才能|立即登录/.test(afterText) || /passport\.163\.com|reg\.163\.com/i.test(state.url))) {
    throw await fail(page, '发布讨论失败：浏览器里的登录态已失效，请点「登录」重新登录后再试。')
  }
  return {
    ok,
    url: String(await page.url().catch(() => '')),
    message: ok ? `已在综合讨论区发布：${title}` : '点了发布，但页面没有明确成功提示，请到讨论区确认一下',
  }
}

/** 读讨论区最近的话题标题和页面文字（给 LLM 出题做参考，也方便调试）。 */
export async function readForumContext(page) {
  const info = await run(page, `(() => { ${DOM_HELPERS}
    const anchors = qa('a[href]').filter(isVisible).filter(el => /topic|thread|post|discuss|forum|detail/i.test(el.getAttribute('href') || ''));
    const titleEls = qa('[class*=topic] a,[class*=thread] a,[class*=postTitle],[class*=post-title],[class*=discuss] a').filter(isVisible);
    const titles = unique([...anchors, ...titleEls].map(el => textOf(el)))
      .filter(text => text.length >= 4 && text.length <= 120)
      .slice(0, 30);
    return { recentTitles: titles, pageText: (document.body ? document.body.innerText : '').slice(0, 8_000) };
  })()`).catch(() => null)
  return {
    recentTitles: Array.isArray(info?.recentTitles) ? info.recentTitles : [],
    pageText: typeof info?.pageText === 'string' ? info.pageText : '',
  }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 自检：每一项都包 try/catch，失败只返回 ok:false，不抛。 */
export async function selfCheck(page) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: clean(detail, 400) })
  let originalUrl = ''
  try { originalUrl = String(await page.url()) } catch (error) { originalUrl = '' }

  try {
    const value = await page.eval('1 + 1')
    add('浏览器调试通道', value === 2, value === 2 ? '页面脚本能正常执行' : `脚本返回了 ${String(value)}`)
  } catch (error) {
    add('浏览器调试通道', false, error instanceof Error ? error.message : String(error))
  }

  let siteOk = false
  try {
    await page.goto(URLS.category, { waitMs: 3_000 })
    const url = String(await page.url())
    const title = String(await page.title())
    siteOk = /icourse163\.org/.test(url)
    add('打开中国大学 MOOC', siteOk, siteOk ? `${title}（${url}）` : `打开后地址变成了 ${url}`)
  } catch (error) {
    add('打开中国大学 MOOC', false, error instanceof Error ? error.message : String(error))
  }

  if (siteOk) {
    try {
      const info = await run(page, `
        const cardBox = q('#j-courseCardListBox, .m-course-card-list, [class*=course-card-list], [class*=courseList]');
        const courseLinks = qa('a[href]').filter(el => /\\/course\\//.test(el.getAttribute('href') || '')).length;
        const courseClasses = qa('[class*=course],[class*=Course]').filter(isVisible).length;
        return { hasCardBox: Boolean(cardBox), courseLinks, courseClasses, textLength: (document.body ? document.body.innerText : '').length };
      `).catch(() => null)
      const recognizable = Boolean(info?.hasCardBox || info?.courseLinks > 0 || info?.courseClasses > 0)
      add('课程列表页面结构', recognizable, recognizable
        ? `找到课程卡片区域（课程链接 ${info?.courseLinks || 0} 个，页面文字 ${info?.textLength || 0} 字）`
        : '页面上没有识别出课程卡片区域；分类接口在本机可能没有渲染出课程，但页面本身能打开')
    } catch (error) {
      add('课程列表页面结构', false, error instanceof Error ? error.message : String(error))
    }

    try {
      const entry = await run(page, `
        const nav = q('.navLoginBtn');
        const hasEntry = Boolean(nav) || /登录\\s*\\|\\s*注册|登录\\/注册/.test(document.body ? document.body.innerText : '');
        const hasEds = Boolean(window.eds && window.eds.loginDialog);
        return { hasEntry, hasEds, navText: nav ? textOf(nav) : '' };
      `).catch(() => null)
      add('登录入口', Boolean(entry?.hasEntry || entry?.hasEds), entry?.hasEntry
        ? `找到登录入口${entry.hasEds ? '（window.eds.loginDialog 可用）' : ''}`
        : '没有找到「登录 | 注册」入口')
    } catch (error) {
      add('登录入口', false, error instanceof Error ? error.message : String(error))
    }
  }

  try {
    const state = await checkLogin(page)
    add('登录状态', state.loggedIn, state.loggedIn
      ? state.message
      : `未登录（正常，需要先点「登录」）：${state.message || '还没有登录中国大学 MOOC'}`)
    if (state.loggedIn) {
      try {
        await page.goto(URLS.mycourse, { waitMs: 3_000 })
        const courses = await run(page, `${EXTRACT_COURSES_BODY}\nreturn collectCourses();`).catch(() => [])
        add('我的课程页面', Array.isArray(courses) && courses.length > 0,
          Array.isArray(courses) && courses.length > 0 ? `读到 ${courses.length} 门课程` : '登录了，但「我的课程」页面没有读到课程卡片')
      } catch (error) {
        add('我的课程页面', false, error instanceof Error ? error.message : String(error))
      }
    } else {
      add('我的课程页面', false, '未登录，跳过「我的课程」检查')
    }
  } catch (error) {
    add('登录状态', false, error instanceof Error ? error.message : String(error))
  }

  // 尽量把页面还原，别把 service 的现场留在分类页
  if (originalUrl && /icourse163\.org/.test(originalUrl)) {
    await page.goto(originalUrl, { waitMs: 1_800 }).catch(() => {})
  }
  return checks
}

#!/usr/bin/env node
/**
 * mooc-inspect —— ZJU-mooc-assistant 的站点适配器自检/侦察脚本。
 *
 * 用法（Windows PowerShell）：
 *   node scripts/mooc-inspect.mjs selfcheck
 *   node scripts/mooc-inspect.mjs login                 # 打开登录弹层，打印 iframe / 输入框结构（不填真密码）
 *   node scripts/mooc-inspect.mjs courses               # 尝试读取「我的课程」（未登录会给出中文原因）
 *   node scripts/mooc-inspect.mjs outline <课程地址或 id>  # 读取章节大纲（公开课程会退回课程详情页大纲）
 *   node scripts/mooc-inspect.mjs kind "第三章 单元测验"    # 看 classifyKind 判定
 *   node scripts/mooc-inspect.mjs survey <url>          # 打开任意页面，打印 title/url/innerText 摘要
 *
 * 环境变量：
 *   MOOC_PORT      调试端口，默认 9233（和 host/cdp.mjs 一致）
 *   MOOC_DATA_DIR  浏览器用户数据目录，默认用 host/util.mjs 里的 $DSH_HOME/ZJU-mooc-assistant/browser-profile
 *   MOOC_BROWSER   浏览器可执行文件路径（可选）
 */
import { Browser } from '../host/cdp.mjs'
import { browserDir } from '../host/util.mjs'
import {
  URLS, classifyKind, fillLogin, openLogin, readMyCourses, readOutline, selfCheck,
} from '../host/mooc.mjs'

const PORT = Number(process.env.MOOC_PORT) > 0 ? Number(process.env.MOOC_PORT) : 9233
const DATA_DIR = process.env.MOOC_DATA_DIR || browserDir()
const BROWSER_PATH = process.env.MOOC_BROWSER || ''

function header(title) {
  console.log(`\n=== ${title} ===`)
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`${check.ok ? '✅' : '⛔'} ${check.name}：${check.detail}`)
  }
  const okCount = checks.filter(check => check.ok).length
  console.log(`— ${okCount}/${checks.length} 项通过`)
}

function printError(error) {
  console.log(`❌ ${error instanceof Error ? error.message : String(error)}`)
  if (error?.dump) {
    console.log(`   当前地址：${error.dump.url}`)
    console.log(`   页面文字：${String(error.dump.text).replace(/\n+/g, ' ⏎ ').slice(0, 400)}…`)
  }
}

async function withPage(fn) {
  const browser = new Browser({ port: PORT, dataDir: DATA_DIR, browserPath: BROWSER_PATH })
  const started = await browser.ensureStarted()
  console.log(`浏览器：${started.exe || '复用已在跑的实例'}（端口 ${PORT}，${started.reused ? '复用' : '新启动'}）`)
  const page = await browser.pageFor('icourse163.org')
  try {
    return await fn(page)
  } finally {
    // 只断开调试通道，不关浏览器窗口（窗口留给用户/下次复用）
    await page._dispose?.()
  }
}

async function survey(page, url) {
  await page.goto(url, { waitMs: 3_000 })
  const info = await page.eval(`(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(el => el.offsetParent);
    const classes = new Set();
    for (const el of document.querySelectorAll('[class]')) {
      String(el.className).split(/\\s+/).forEach(name => { if (name) classes.add(name); });
    }
    return {
      url: location.href,
      title: document.title,
      textLength: (document.body ? document.body.innerText : '').length,
      text: (document.body ? document.body.innerText : '').slice(0, 1200),
      anchors: anchors.slice(0, 40).map(el => ({ text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), href: el.getAttribute('href') })),
      classSample: Array.from(classes).filter(name => /course|chapter|unit|quiz|question|learn|card|login|avatar/i.test(name)).slice(0, 80),
    };
  })()`)
  console.log(JSON.stringify({ url: info.url, title: info.title, textLength: info.textLength }, null, 2))
  console.log('\n-- 相关 class --')
  console.log((info.classSample || []).join('  '))
  console.log('\n-- 页面文字（前 900 字）--')
  console.log((info.text || '').slice(0, 900))
  console.log('\n-- 链接（前 20 个）--')
  for (const anchor of (info.anchors || []).slice(0, 20)) console.log(`  ${anchor.text} -> ${anchor.href}`)
}

async function inspectLogin(page) {
  await openLogin(page, { categoryFirst: false })
  console.log('登录弹层已打开')
  const frames = await page._send('Page.getFrameTree').catch(() => null)
  const list = []
  const walk = (node, depth) => {
    list.push({ depth, url: node.frame?.url || '', name: node.frame?.name || '' })
    for (const child of node.childFrames || []) walk(child, depth + 1)
  }
  if (frames?.frameTree) walk(frames.frameTree, 0)
  console.log(`frame 树：${list.length} 个`)
  for (const frame of list) console.log(`  ${'  '.repeat(frame.depth)}• ${frame.url || '(about:blank)'}`)

  const infos = await page.eval(`(() => Array.from(document.querySelectorAll('iframe')).map((el, index) => {
    const rect = el.getBoundingClientRect();
    return { index, src: (el.src || '').slice(0, 100), w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
  }))()`)
  console.log('\niframe 在页面上的位置：')
  for (const info of infos || []) console.log(`  #${info.index} ${info.w}×${info.h} @(${info.x},${info.y}) ${info.src}`)

  // 只检测，不填真密码（用一个假密码验证输入框能被写进去，然后立刻改成空）
  try {
    const result = await fillLogin(page, { email: 'demo@example.com', password: 'zju-mooc-demo-not-a-real-password' })
    console.log(`\nfillLogin 检测：✅ mode=${result.mode} needSubmit=${result.needSubmit}`)
    await page.eval(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type=password]'));
      for (const input of inputs) {
        const proto = HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`).catch(() => false)
  } catch (error) {
    printError(error)
    const info = await page.eval(`(() => ({ text: (document.body ? document.body.innerText : '').slice(0, 600), iframes: document.querySelectorAll('iframe').length }))()`).catch(() => null)
    console.log('页面现场：', JSON.stringify(info, null, 2))
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const arg = rest.join(' ')
  if (!command) {
    console.log('用法：node scripts/mooc-inspect.mjs <selfcheck|login|courses|outline|kind|survey> [参数]')
    process.exit(1)
  }
  if (command === 'kind') {
    const text = arg || '第三章 单元测验'
    console.log(`classifyKind(${JSON.stringify(text)}) = ${classifyKind(text, '')}`)
    for (const sample of ['期末考试', '单元作业', '综合讨论区', '1.1 课程介绍', '第2周编程练习', '课件 PDF', '随堂测验']) {
      console.log(`  ${sample} -> ${classifyKind(sample, '')}`)
    }
    return
  }
  if (command === 'survey') {
    if (!arg) { console.log('survey 需要一个 url'); process.exit(1) }
    await withPage(page => survey(page, arg))
    return
  }
  await withPage(async page => {
    if (command === 'selfcheck') {
      header('selfCheck')
      const checks = await selfCheck(page)
      printChecks(checks)
      return
    }
    if (command === 'login') {
      header('登录弹层/iframe 结构')
      await inspectLogin(page)
      return
    }
    if (command === 'courses') {
      header('readMyCourses')
      try {
        const courses = await readMyCourses(page, {})
        console.log(`读到 ${courses.length} 门课程：`)
        for (const course of courses) console.log(`  [${course.spoc ? 'SPOC' : 'MOOC'}] ${course.title} | ${course.teacher} | ${course.term} | ${course.progress}`)
      } catch (error) {
        printError(error)
      }
      return
    }
    if (command === 'outline') {
      header('readOutline')
      const course = arg
        ? { id: (/[A-Za-z]+-\d+/.exec(arg) || [arg])[0], title: '命令行指定课程', url: /^https?:\/\//.test(arg) ? arg : '' }
        : { id: 'ZJU-199001', title: '程序设计入门——C语言', url: 'https://www.icourse163.org/course/ZJU-199001' }
      try {
        const outline = await readOutline(page, course)
        console.log(`课程 ${outline.courseId}，来源 ${outline.source}，${outline.chapters.length} 章：`)
        for (const chapter of outline.chapters.slice(0, 12)) {
          console.log(`  第${chapter.index}章 ${chapter.title}`)
          for (const unit of chapter.units.slice(0, 8)) {
            console.log(`    - [${unit.kind}] ${unit.title} @ ${unit.url || '(无链接)'}`)
          }
        }
      } catch (error) {
        printError(error)
      }
      return
    }
    console.log(`未知命令：${command}`)
  })
  process.exit(0)
}

main().catch(error => {
  printError(error)
  process.exit(1)
})

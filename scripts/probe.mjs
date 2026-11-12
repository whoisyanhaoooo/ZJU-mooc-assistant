/**
 * 浏览器底座自检脚本：node scripts/probe.mjs [url]
 *
 * 启动（或复用）可控浏览器 → 打开目标页面（默认中国大学 MOOC 全部课程）→
 * 打印 title / url / iframe 数 / Cookie 名 → 截图到 $DSH_HOME/ZJU-mooc-assistant/shots/probe.png。
 * 退出码 0 表示正常。**不要在这里关闭浏览器**，后续队友还要接着用。
 */
import path from 'node:path'
import { Browser } from '../host/cdp.mjs'
import { ensureDir, messageOf, shotsDir } from '../host/util.mjs'

const url = process.argv[2] || 'https://www.icourse163.org/category/all'

const browser = new Browser({
  port: 9233,
  log: (...args) => console.log('[browser]', ...args),
})

try {
  const started = await browser.ensureStarted()
  console.log(`浏览器就绪：${started.exe || '（未知路径）'}，端口 ${started.port}，${started.reused ? '复用已有实例' : '本次启动'}`)

  const page = await browser.open(url)
  // 等真实内容出来（站点慢的时候放宽到 25 秒）；失败也继续，先把手上能看到的信息打出来
  await page.waitFor("document.readyState === 'complete'", { timeoutMs: 25_000 }).catch(() => {})
  await page.waitForSelector('body', { timeoutMs: 10_000 }).catch(() => {})

  const title = await page.title()
  const currentUrl = await page.url()
  const iframes = await page.eval('document.querySelectorAll("iframe").length')
  const cookies = await page.cookies('icourse163')
  const screenshot = await page.screenshot(path.join(ensureDir(shotsDir()), 'probe.png'))

  console.log('--- probe 结果 ---')
  console.log(JSON.stringify({
    title,
    url: currentUrl,
    iframes,
    cookies: cookies.map(cookie => cookie.name),
    screenshot,
  }, null, 2))
  process.exit(0)
} catch (error) {
  console.error('probe 失败：', messageOf(error))
  process.exit(1)
}

/** 插件自己的数据、浏览器目录与文本小工具。路径都在 $DSH_HOME/ZJU-mooc-assistant 下，不往 profile 里写。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const APP_ID = 'ZJU-mooc-assistant'
export const PLUGIN_TITLE = 'ZJU-mooc-assistant'
export const SETTINGS_VERSION = 1

export function dshHome() {
  const given = process.env.DSH_HOME
  if (given && given.trim()) return path.resolve(given)
  return path.join(os.homedir(), '.dsh')
}

export function dataRoot() {
  const home = dshHome()
  const root = path.join(home, APP_ID)
  // 0.2.0 之前的数据目录叫 mooc-companion：第一次启动新版本时自动迁移，
  // 保留登录态、任务和浏览器 Profile。迁移失败不阻塞启动，旧目录保持原样作为备份。
  const legacy = path.join(home, 'mooc-companion')
  if (!fs.existsSync(root) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, root)
    } catch {
      try { fs.cpSync(legacy, root, { recursive: true }) } catch { /* ignore */ }
    }
  }
  return root
}

export function browserDir() {
  // 测试/多实例时允许单独指定浏览器用户数据目录；平时就在插件数据目录下
  const given = process.env.MOOC_COMPANION_BROWSER_DIR
  if (given && given.trim()) return path.resolve(given)
  return path.join(dataRoot(), 'browser-profile')
}

export function shotsDir() {
  return path.join(dataRoot(), 'shots')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(file, value, mode = 0o600) {
  ensureDir(path.dirname(file))
  const temp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode, flush: true })
  fs.renameSync(temp, file)
}

export function readText(file, limit = 2_000_000) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return ''
    const fd = fs.openSync(file, 'r')
    try {
      const size = Math.min(stat.size, limit)
      const buffer = Buffer.alloc(size)
      fs.readSync(fd, buffer, 0, size, 0)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

export function cleanString(value, max = 400) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Windows 文件名不能带这些字符；同时避免结尾的点和空格。 */
export function safeFilename(value, fallback = '记录') {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (cleaned || fallback).slice(0, 120)
}

export function stripCodeFences(text) {
  let value = String(text ?? '').trim()
  const fence = value.match(/^```(?:json|markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) value = fence[1].trim()
  return value
}

export function truncate(text, limit, note = '\n\n（后续内容因过长已截断）') {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(0, limit) + note
}

export function unique(list) {
  return [...new Set(list.filter(Boolean))]
}

/** 把任意值裁成 ISO 字符串或 null。 */
export function isoOrNull(value) {
  if (!value) return null
  const time = Date.parse(String(value))
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** 百分比裁剪到 0–100 的整数。 */
export function percent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, Math.round(number)))
}

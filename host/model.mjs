/**
 * 通用模型能力：让插件自己问一次 DSH 当前选择的默认模型。
 *
 * 照参考插件 dsh-zju-replay-notes/host/model.mjs 的写法改通用版：
 * - askModel：流式收集 text-delta / block-end，出错、被中止、max-tokens 都给一句中文原因；
 * - askJson：在 askModel 基础上要求「只输出 JSON」，先剥代码围栏，再截取第一个 {/[ 到最后一个 }/] 兜底，
 *   JSON.parse 失败就带着错误和上次输出重试（默认 2 次），最终失败抛错并附最后输出开头。
 *
 * 本模块不碰浏览器、不碰文件，只依赖 ctx.get('llm') 与 ctx.get('agentDefaultModel')。
 */
import { messageOf, stripCodeFences, truncate } from './util.mjs'

const DEFAULT_MAX_TOKENS = 32_000
const DEFAULT_TIMEOUT_MS = 300_000
// 太短的超时基本一定失败，留 30 秒下限；超时本身是保护，不是让模型多想。
const MIN_TIMEOUT_MS = 30_000
const LAST_OUTPUT_SNIPPET = 500
const RETRY_OUTPUT_SNIPPET = 800

/** 解析成功时把原始输出挂在返回值这个 symbol 上（JSON.stringify / 序列化不会带出来）。 */
export const RAW_TEXT = Symbol('mooc-companion.rawText')

/** 取 askJson 返回值上挂的原始文本；拿不到就返回空串。 */
export function rawOf(value) {
  return (value && typeof value === 'object' && value[RAW_TEXT]) || ''
}

/** 只输出 JSON 的硬性要求，拼在 system 与 user 两边，模型更容易照做。 */
const JSON_SYSTEM = `你是严格的 JSON 生成器。你只输出一个合法的 JSON 对象或数组，不输出任何解释、开场白、结束语、Markdown 代码围栏或思考过程。
字符串一律用英文双引号；不要用中文引号当分隔符；不要写注释；不要有多余的尾逗号；不要输出 JSON 之外的任何字符。`

const JSON_RULES = `输出要求（必须遵守）：
1. 只输出一个合法 JSON，不要任何解释文字，不要 \`\`\` 代码围栏。
2. 字段名必须和给定结构完全一致，不要多造字段、不要漏字段。
3. 字符串用英文双引号；内容里需要引号时用「」或转义，别让 JSON 坏掉。
4. 数字、布尔值不要加引号；不确定就按最合理的值填写，不要输出 null 之外的空占位。`

function clean(value, max = 4_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 标记成「模型侧错误」：外层不再改写成「模型调用失败：…」这种套娃文案。 */
function fail(message, extra) {
  return Object.assign(new Error(message), { fromModel: true }, extra || {})
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** 把模型调用抛出来的底层错误翻成用户看得懂的中文；模型侧的清晰报错原样放行。 */
function translateError(error, { signal, timeout, waitMs }) {
  if (error?.fromModel || error?.partial) return error
  if (signal?.aborted) return new Error('操作已取消，模型调用中止了。')
  const name = error?.name
  if (name === 'TimeoutError' || timeout?.aborted) {
    return new Error(`模型调用超时（${Math.round(waitMs / 1000)} 秒没有返回完整结果）。可能是网络慢或内容太长，可以稍后重试。`)
  }
  if (name === 'AbortError') return new Error('模型调用被中止了。')
  const raw = messageOf(error).trim()
  if (!raw) return new Error('模型调用失败，没有拿到任何结果。')
  // 底层报错多半是英文，加一句中文场景说明，但保留原文供排查。
  return new Error(`模型调用失败：${raw}`)
}

/**
 * 问一次默认模型，返回模型输出的纯文本。
 *
 * @param {any} ctx DSH ctx（只用到 ctx.get）
 * @param {object} options
 * @param {string} [options.system] 系统提示（中文，说明身份与规矩）
 * @param {string} options.text 用户提示，必填
 * @param {number} [options.maxTokens=32000] 输出上限
 * @param {string} [options.reasoningEffort] '' | 'low' | 'medium' | 'high' | 'max'
 * @param {number} [options.timeoutMs=300000] 超时（毫秒），最小 30 秒
 * @param {AbortSignal} [options.signal] 取消信号
 * @returns {Promise<string>}
 */
export async function askModel(ctx, options = {}) {
  const opts = options || {}
  const system = clean(opts.system, 20_000)
  const text = String(opts.text ?? '').trim()
  const reasoningEffort = clean(opts.reasoningEffort, 20)
  const signal = opts.signal
  if (signal?.aborted) throw new Error('操作已取消，没有开始调用模型。')
  if (!text) throw new Error('没有要交给模型的内容：这次请求是空的。')

  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('当前环境没有可用的模型服务，无法完成这一步。')
  let selection = null
  try {
    selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
  } catch {
    selection = null
  }
  if (!selection?.provider || !selection?.model) throw new Error('还没有选择默认模型，请先在 DSH 设置里选一个模型再试。')

  const maxTokens = Math.max(1_000, Number(opts.maxTokens) || DEFAULT_MAX_TOKENS)
  const waitMs = Math.max(MIN_TIMEOUT_MS, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const timeout = AbortSignal.timeout(waitMs)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout

  const once = async (extra = {}) => {
    let delta = ''
    const blocks = []
    let finishReason = null
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens,
      signal: abort,
      ...extra,
    })) {
      const type = chunk?.type
      if (type === 'text-delta') delta += chunk?.text ?? chunk?.delta ?? ''
      else if (type === 'block-end' && chunk?.block?.type === 'text') blocks.push(chunk.block.text ?? '')
      else if (type === 'finish') finishReason = chunk?.reason ?? null
    }

    const value = (delta || blocks.join('')).trim()
    if (finishReason) {
      const kind = typeof finishReason === 'string' ? finishReason : finishReason?.kind
      const failure = finishReason?.failure?.message || finishReason?.message || ''
      if (kind === 'error') throw fail(`模型返回错误：${failure || '未知原因'}`)
      if (kind === 'aborted') throw fail('模型调用被中止了（被取消或超时）。')
      if (kind === 'max-tokens') {
        throw fail('模型输出达到长度上限（max-tokens），这次内容不完整。可以把「模型思考强度」调低，或把题目/材料减少一些再重试。', {
          partial: value,
        })
      }
    }
    if (!value) throw fail('模型没有返回任何文字。')
    return value
  }

  try {
    return await once(reasoningEffort ? { reasoningEffort } : {})
  } catch (error) {
    const first = translateError(error, { signal, timeout, waitMs })
    // 有些模型/provider 不认 reasoningEffort；用户只是调了「思考强度」时，退回默认再试一次。
    // max-tokens 的 incomplete 输出和用户主动取消不重试，避免白烧额度。
    if (reasoningEffort && !first?.partial && !signal?.aborted) {
      try {
        return await once({})
      } catch (retryError) {
        throw translateError(retryError, { signal, timeout, waitMs })
      }
    }
    throw first
  }
}

/** 截取第一个 { 或 [ 到最后一个 } 或 ]，兜掉模型前面写的「好的，结果如下」。 */
function sliceJson(text) {
  const source = String(text ?? '')
  const starts = [source.indexOf('{'), source.indexOf('[')].filter((index) => index >= 0)
  if (!starts.length) return ''
  const start = Math.min(...starts)
  const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'))
  if (end <= start) return ''
  return source.slice(start, end + 1)
}

/** 按「先信任原样、再兜围栏、再兜截取、再修尾逗号」的顺序给出候选文本，去重后逐个试。 */
function jsonCandidates(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!source) return []
  const fenced = stripCodeFences(source)
  const list = [
    fenced,
    source,
    sliceJson(fenced),
    sliceJson(source),
    stripCodeFences(sliceJson(source)),
  ]
  const seen = new Set()
  const out = []
  for (const item of list) {
    const value = String(item ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 从一段文字里抠出 JSON 对象/数组；抠不出来就抛中文错误。
 * 允许：纯 JSON、```json 围栏、围栏外带解释、结尾多一个逗号。
 * 不允许（会抛错，让上层重试）：空文本、只有标量、语法坏掉。
 */
export function parseJsonText(text) {
  const candidates = jsonCandidates(text)
  if (!candidates.length) throw new Error('模型返回的内容是空的')
  let firstError = null
  for (const candidate of candidates) {
    for (const variant of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      let parsed
      try {
        parsed = JSON.parse(variant)
      } catch (error) {
        if (!firstError) firstError = error
        continue
      }
      if (parsed && typeof parsed === 'object') return parsed
      throw new Error('模型返回的 JSON 是单个值（字符串/数字），不是对象或数组')
    }
  }
  const reason = firstError instanceof Error ? firstError.message : String(firstError ?? '')
  throw new Error(`这段内容不是合法 JSON（${reason || '格式不对'}）`)
}

/**
 * 要求模型只输出 JSON，并解析。
 *
 * @param {any} ctx
 * @param {object} options 同 askModel，可额外在 options 里带 schemaHint / retries
 * @param {object} [extraOptions] { schemaHint?, retries? }（契约里的第三个参数）
 * @returns {Promise<any>} 解析后的对象/数组；原始输出挂在其 [RAW_TEXT] 上
 */
export async function askJson(ctx, options = {}, extraOptions = {}) {
  const opts = options || {}
  const extra = extraOptions || {}
  const schemaHint = clean(extra.schemaHint ?? opts.schemaHint, 6_000)
  const retries = clampInt(extra.retries ?? opts.retries, 0, 4, 2)
  const signal = opts.signal
  const base = String(opts.text ?? '').trim()
  if (!base) throw new Error('没有要交给模型的内容：这次请求是空的。')
  const systemText = [clean(opts.system, 20_000), JSON_SYSTEM].filter(Boolean).join('\n\n')

  let lastRaw = ''
  let lastError = null
  for (let round = 0; round <= retries; round += 1) {
    const parts = [base, JSON_RULES]
    if (schemaHint) parts.push(`输出 JSON 的结构必须是（字段名照抄）：\n${schemaHint}`)
    if (round > 0) {
      parts.push(
        `注意：上一次输出不是合法 JSON，错误：${lastError?.message || '解析失败'}。\n`
        + `上一次输出的开头是：\n${truncate(lastRaw, RETRY_OUTPUT_SNIPPET, '……')}\n`
        + '请严格只输出 JSON：从 { 或 [ 开始，到 } 或 ] 结束，不要解释、不要代码围栏。',
      )
    }
    lastRaw = await askModel(ctx, {
      system: systemText,
      text: parts.join('\n\n'),
      maxTokens: opts.maxTokens,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      signal,
    })
    try {
      const value = parseJsonText(lastRaw)
      try {
        value[RAW_TEXT] = lastRaw
      } catch {
        // 只读/冻结对象挂不上就算了，raw 只是方便上层记录。
      }
      return value
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw new Error('操作已取消，不再重试。')
    }
  }

  const error = new Error(
    `模型连续 ${retries + 1} 次都没有返回合法 JSON：${lastError?.message || '格式不对'}。`
    + `最后一次输出的开头是：${truncate(lastRaw, LAST_OUTPUT_SNIPPET, '……')}`,
  )
  error.lastOutput = lastRaw
  throw error
}

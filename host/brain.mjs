/**
 * ZJU-mooc-assistant的「脑子」：答题、写课堂讨论的问题、总结一节课。
 *
 * 全部能力都走 model.mjs 的 askModel / askJson，不碰浏览器、不碰文件系统。
 *
 * ── Prompt 为什么这么设计（写给后来维护的人看）────────────────────────────────
 *
 * 1) 身份：一律设定成「正在上这门课的学生」，而不是「AI 助手」。
 *    这样模型的语气、取舍标准会向学生靠：先读题干再看选项、会用课上讲的结论、
 *    遇到没讲的会基于学科知识推理而不是编一段看起来对的话。
 *
 * 2) 答题（answerQuizWithModel）
 *    - 题面用「第 N 题（题型）＋题干＋选项 key. label」逐题铺开，保留原始 index，
 *      保证模型回填的 index 能直接对上 mooc 的题目顺序（applyAnswers 依赖它）。
 *    - 课上内容（lesson.summary / lesson.transcript）作为「依据」放前面，明确要求
 *      「课堂讲过就按课堂的讲法」，课堂没覆盖的才用学科知识；材料里没有的不要编。
 *    - 反向问法（「不正确/不属于」）、单位、限定词在 prompt 里点明，这是选择题最常见的坑。
 *    - 第一次机会：提醒这是第 1 次，认真做但不必畏手畏脚。
 *    - 第二次机会（attempt=2 或带 previous 错题）：把上次的 score 和每道错题的
 *      chosen/correct 摊开，要求逐题反思「上次为什么错」，并且明确「这是最后一次机会，
 *      必须全对」；同时提醒「别为了避开上次答案把本来对的题改错」。
 *      如果 mooc 已经把正确答案公布了，让模型以公布的答案为准并想清楚原因（判分标准在课程那边）。
 *    - 输出 JSON 固定三元组：answers[]（index/choice?/text?/reason）、confidence、reasoning，
 *      方便服务层直接 applyAnswers，也给用户一个「这题有多确定」的参考。
 *    - 模型漏题/题型答错（例如判断题给了选项文字但连不上任何 key）绝不编造：先带着
 *      「缺了第几题」再问一次，仍然缺就直接抛错停下，由 service 决定重来。
 *
 * 3) 讨论区提问（writeDiscussionQuestion）
 *    - 目标不是「总结这节课」，是「针对老师提出的问题参与讨论」：优先从课堂字幕/小结里找老师
 *      明确提出的问题，其次看讨论区页面里老师/助教的置顶讨论题；找到后直接回应它。
 *    - 找不到老师的问题时，才围绕本节最核心、最容易产生疑问的结论提问，不许假装老师问过。
 *    - 先让模型给 3 个不同角度的候选（结论为什么成立、适用条件、跨章节联系、现实例子），
 *      再用 best 选一条。
 *    - 标题 ≤30 字、正文 80–200 字是硬约束（讨论区刷屏太长没人看、太短像水帖），
 *      代码里会真的按「字数」校验（中文按字符数，不按 byte），不合格先重问一轮，最后才裁剪兜底。
 *    - 语气要求「中立地提问、讨论」：讲清自己的理解和具体想问的点，直接问出来；
 *      不表达情绪、不诉苦、不卖萌、不夸张，也禁止 AI 腔和作业腔
 *      （「首先/其次/最后」「综上所述」「让我们一起」「浅谈……」）。
 *      具体知识点要靠 lesson.summary/transcript/forum 撑着，没材料就围绕本节标题最核心的概念问，
 *      不允许编造课堂没讲过的术语和事实。
 *
 * 4) 课堂总结（summarizeLesson）
 *    - 产出不是给用户看的读书笔记，而是给答题和写讨论用的上下文：
 *      summary 讲清主线（150–300 字）、keyPoints 是具体知识点（3–8 条）、
 *      confusion 是一个真学生会卡住的点（1–2 句，写讨论问题时最好用）。
 *    - 所以要求「别逐句复述」「keyPoints 每条是一个术语/公式/结论，不是『学习了…』」。
 *
 * 5) 稳健性：所有结构化输出都走 askJson（剥围栏 + 截取 + 重试），
 *    解析/字段结构异常会重试一次并给错误反馈；最终仍拿不到可用结果就抛中文错误，
 *    绝不用空答案或空问题糊弄过去。
 */
import { askJson, rawOf } from './model.mjs'
import { cleanString, truncate } from './util.mjs'

// 材料长度上限：字幕通常几千到几万字，全塞进去会把 token 烧光、也会稀释重点。
const MAX_SUMMARY_CHARS = 6_000
const MAX_TRANSCRIPT_CHARS = 14_000
const MAX_TRANSCRIPT_FOR_SUMMARY = 40_000

const QUIZ_SYSTEM = `你是中国大学 MOOC 上一门课的学生，正在认真做这份在线测验。
你的作答标准：
1. 先逐题把题干读完，再看每一个选项；特别注意「不正确」「不属于」「除了」这类反向问法，以及单位、范围、限定词。
2. 如果给了这节课的小结或字幕，优先用课堂里讲过的定义、公式、结论和老师强调的易错点；课堂材料没覆盖的部分，用你扎实的学科知识推理。
3. 判断题按题干的真实含义判断，不要被「看起来像书上的话」带偏；多选题逐项核对，漏选会丢分、乱选也会丢分。
4. 不确定的题也要给出你认为最可能的答案，并在 reason 里说清依据；不要空着不答。
5. 只输出 JSON，不输出任何解释性文字、Markdown 或代码围栏之外的字符。`

const DISCUSSION_SYSTEM = `你是中国大学 MOOC 上一门课的学生，刚上完一节课，正在课程综合讨论区参与讨论。
你优先回应老师在这节课里提出的问题：说清自己的理解，再针对老师的问题提出具体的追问或不同角度。
你的目的是就具体知识点提问、和同学讨论，语气中立、平实：说清自己的理解，把想问的问题直接问出来。
你不需要表达情绪，不诉苦、不卖萌、不夸张；你不是老师、不是助教、不是 AI 写作助手；
不要总结全文，不要写学习心得，不要说教；不要假装老师说过没说过的话。`

const SUMMARY_SYSTEM = `你是中国大学 MOOC 上一门课的学生，正在课后整理这节课的要点，供自己做测验和向讨论区提问时参考。
只依据给你的课堂材料；材料没讲到的不编造。语言用简体中文，像学生自己的笔记，不写套话。`

const QUIZ_SCHEMA = `{
  "answers": [
    { "index": 1, "choice": "B", "reason": "为什么选它，1–2 句" },
    { "index": 2, "choice": ["A", "C"], "reason": "多选，逐项说明" },
    { "index": 3, "choice": "true", "reason": "判断题用 true/false" },
    { "index": 4, "text": "填空或简答写成文字", "reason": "依据" }
  ],
  "confidence": 0.85,
  "reasoning": "整份卷子的整体思路，2–4 句"
}`

const DISCUSSION_SCHEMA = `{
  "candidates": [
    { "title": "不超过 30 字的标题", "content": "80–200 字的正文，一个自然段，最后把问题问出来" }
  ],
  "best": 1
}`

const SUMMARY_SCHEMA = `{
  "summary": "150–300 字，这一节讲了什么、主线怎么走",
  "keyPoints": ["具体知识点 1", "具体知识点 2"],
  "confusion": "1–2 句，一个真学生会卡住或容易混淆的地方"
}`

function effortOf(settings) {
  return cleanString(settings?.reasoningEffort, 20) || undefined
}

function normalized(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 中文按「字符」算长度，不按 UTF-16 code unit（避免 emoji/生僻字算两个）。 */
function charCount(text) {
  return Array.from(normalized(text)).length
}

function sliceChars(text, max) {
  return Array.from(normalized(text)).slice(0, max).join('')
}

function typeLabel(type) {
  return ({ single: '单选', multiple: '多选', judge: '判断', fill: '填空', short: '简答' })[type] || '其他'
}

function unitLabel(unit) {
  return ({ video: '视频课', quiz: '测验', homework: '作业', exam: '考试', discussion: '讨论' })[unit?.kind] || '学习单元'
}

/** 把 mooc 读到的控件类型翻成中文，别让 prompt 里混着 radio/checkbox 这种页面术语。 */
function inputLabel(inputKind) {
  return ({
    radio: '单选按钮',
    checkbox: '复选框',
    text: '单行输入框',
    textarea: '多行输入框',
  })[inputKind] || ''
}

// ── 选项匹配：模型可能回 key（A）、回选项文字、回「A. 文字」、回 1/2/3，都要能对上 ─────────

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', '对', '正确', '是', '√', '✓', 'right', 'correct'])
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', '错', '错误', '否', '×', '✗', 'x', 'wrong', 'incorrect'])

/** 去掉「A.」「1、」「选项」这类前缀和空白/标点，只留可比的内容。 */
function labelOf(value) {
  return String(value ?? '')
    .replace(/^\s*(?:选项)?[A-Za-z0-9]{1,2}\s*[.、．:：)）]\s*/, '')
    .replace(/[\s"'“”‘’「」『』]/g, '')
    .replace(/[。．.，,；;：:！!？?、]/g, '')
    .toLowerCase()
    .trim()
}

function judgeValue(value) {
  const text = labelOf(value)
  if (!text) return null
  if (TRUE_WORDS.has(text)) return 'true'
  if (FALSE_WORDS.has(text)) return 'false'
  if (/^(正确|对|是|true)/.test(text)) return 'true'
  if (/^(错误|错|否|false)/.test(text)) return 'false'
  return null
}

/**
 * 把模型给的一个答案对回 mooc 的选项 key。对不上返回 null（上层当漏题处理，不硬猜）。
 */
function matchOption(question, raw) {
  if (raw == null) return null
  const value = typeof raw === 'boolean' ? (raw ? 'true' : 'false') : String(raw).trim()
  if (!value) return null
  const options = question.options || []

  // 1. 本来就是选项 key（大小写不敏感）。
  const direct = options.find((option) => option.key === value)
    || options.find((option) => option.key.toLowerCase() === value.toLowerCase())
  if (direct) return direct.key

  // 2. 判断题：true/false/正确/错误/√/×… 归一化后再找对应选项。
  if (question.type === 'judge') {
    const judge = judgeValue(value)
    if (judge) {
      const byKey = options.find((option) => String(option.key).toLowerCase() === judge)
      if (byKey) return byKey.key
      const byLabel = options.find((option) => judgeValue(option.label) === judge)
      if (byLabel) return byLabel.key
      // 两个选项、都没有可识别标签时，按常见顺序（正确/错误）兜一次。
      if (options.length === 2) return (judge === 'true' ? options[0] : options[1]).key
      return judge
    }
  }

  // 3. 选项文字相等（去前缀、去标点后比较）。
  const target = labelOf(value)
  if (target) {
    const same = options.find((option) => labelOf(option.label) === target)
    if (same) return same.key
    // 模型说了「A. 正确」这种整行，或把选项文字抄长了一点：唯一包含匹配。
    const contains = options.filter((option) => {
      const label = labelOf(option.label)
      return label && (label.includes(target) || target.includes(label))
    })
    if (contains.length === 1) return contains[0].key
  }

  // 4. 模型只给了字母或序号，而选项 key 不是 A/B/C（例如 key 是 true/false 或文本）。
  if (/^[A-Za-z]$/.test(value) && options.length) {
    const at = value.toUpperCase().charCodeAt(0) - 65
    if (options[at]) return options[at].key
  }
  if (/^\d$/.test(value) && options.length) {
    const at = Number(value) - 1
    if (options[at]) return options[at].key
  }
  return null
}

/** 多选的 choice 可能是数组、逗号分隔、连写「AC」，统一拆成 token。 */
function splitChoices(value, question) {
  if (Array.isArray(value)) return value
  const text = String(value ?? '').trim()
  if (!text) return []
  if (matchOption(question, text)) return [text]
  const parts = text.split(/[,，、;；/\s]+/).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) return parts
  const letters = text.replace(/[^A-Za-z0-9]/g, '')
  if (letters.length > 1 && /^[A-Za-z]+$/.test(letters)) return letters.split('')
  if (letters.length > 1 && /^\d+$/.test(letters)) return letters.split('')
  return parts
}

// ── 题目 / 答案的规范化 ────────────────────────────────────────────────────

function normalizeQuestions(list) {
  const questions = []
  for (const item of Array.isArray(list) ? list : []) {
    const index = Number(item?.index)
    if (!Number.isFinite(index)) continue
    questions.push({
      index,
      type: cleanString(item?.type, 20) || 'single',
      stem: String(item?.stem ?? '').trim(),
      options: Array.isArray(item?.options)
        ? item.options
          .map((option) => ({ key: String(option?.key ?? '').trim(), label: String(option?.label ?? '').trim() }))
          .filter((option) => option.key)
        : [],
      inputKind: cleanString(item?.inputKind, 20) || null,
    })
  }
  if (!questions.length) throw new Error('没有读到题目（questions 为空或缺少 index），没法作答。')
  return questions
}

function extractAnswers(parsed) {
  const list = parsed?.answers ?? parsed?.answer ?? parsed?.result?.answers ?? parsed?.data?.answers
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object') {
    return Object.entries(list).map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return { index: key, ...value }
      const text = String(value ?? '').trim()
      // 单个字母/数字按选项 key 理解，更长的文字按填空答案理解。
      return /^[A-Za-z0-9]$/.test(text) ? { index: key, choice: text } : { index: key, text }
    })
  }
  return []
}

function normalizeTextAnswer(question, item) {
  const text = String(item?.text ?? item?.answer ?? item?.value ?? '').trim()
  if (!text) return null
  return { index: question.index, text, reason: cleanString(item?.reason ?? item?.why, 300) }
}

function normalizeChoiceAnswer(question, item) {
  const reason = cleanString(item?.reason ?? item?.why, 300)
  const rawChoice = Array.isArray(item?.choice) ? item.choice : (item?.choice ?? item?.answer ?? item?.value)
  if (question.type === 'multiple') {
    const keys = [...new Set(splitChoices(rawChoice, question).map((value) => matchOption(question, value)).filter(Boolean))]
    if (!keys.length) return null
    return { index: question.index, choice: keys, reason }
  }
  if (question.type === 'judge') {
    // 契约要求判断题统一返回 'true'/'false'（mooc 负责映射到页面上的「正确/错误」）。
    const judge = judgeAnswer(question, rawChoice)
    if (!judge) return null
    return { index: question.index, choice: judge, reason }
  }
  const first = Array.isArray(rawChoice) ? rawChoice[0] : rawChoice
  const key = matchOption(question, first)
  if (!key) return null
  return { index: question.index, choice: key, reason }
}

/**
 * 判断题归一化：模型可能给 true/false、正确/错误、√/×，也可能给选项 key（A/B）或选项文字。
 * 统一收成 'true' / 'false'。
 */
function judgeAnswer(question, rawChoice) {
  const raw = Array.isArray(rawChoice) ? rawChoice[0] : rawChoice
  if (raw == null) return null
  const direct = judgeValue(raw)
  if (direct) return direct
  // 给的是选项 key 或选项文字：找到那个选项，按它的标签判断对错。
  const key = matchOption(question, raw)
  if (!key) return null
  const option = (question.options || []).find((candidate) => candidate.key === key)
  return option ? judgeValue(option.label) : null
}

function normalizeOneAnswer(question, item) {
  if (!item) return null
  const wantsText = question.type === 'fill' || question.type === 'short'
    || question.inputKind === 'text' || question.inputKind === 'textarea'
  return wantsText ? normalizeTextAnswer(question, item) : normalizeChoiceAnswer(question, item)
}

function normalizeConfidence(value) {
  let number = Number(value)
  if (!Number.isFinite(number)) return 0.5
  if (number > 1 && number <= 100) number /= 100
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100))
}

function reasoningOf(parsed, answers) {
  const direct = cleanString(parsed?.reasoning ?? parsed?.analysis ?? parsed?.explanation, 1_500)
  if (direct) return direct
  const lines = answers.filter((answer) => answer.reason).map((answer) => `第 ${answer.index} 题：${answer.reason}`)
  return truncate(lines.join('；'), 1_500, '……')
}

/**
 * 把模型的 answers 对回题目；返回对齐后的答案 + 漏答的题号。
 * 这里刻意不做「猜一个」：对不上就是漏题，交给上层重问或报错。
 */
function alignAnswers(questions, parsed) {
  const rawAnswers = extractAnswers(parsed)
  const byIndex = new Map()
  for (const item of rawAnswers) {
    const index = Number(item?.index ?? item?.questionIndex ?? item?.q)
    if (Number.isFinite(index)) byIndex.set(index, item)
  }
  const answers = []
  const missing = []
  for (const question of questions) {
    const answer = normalizeOneAnswer(question, byIndex.get(question.index))
    if (answer) answers.push(answer)
    else missing.push(question.index)
  }
  return { answers, missing }
}

// ── 课堂材料 ────────────────────────────────────────────────────────────────

function lessonBlock(lesson) {
  const summary = String(lesson?.summary ?? '').trim()
  const transcript = String(lesson?.transcript ?? '').trim()
  const parts = []
  if (summary) parts.push(`### 这节课的小结（优先依据）\n${truncate(summary, MAX_SUMMARY_CHARS, '……')}`)
  if (transcript) parts.push(`### 这节课的字幕/课堂记录（可能有识别错误，遇到明显口误按学科常识理解）\n${truncate(transcript, MAX_TRANSCRIPT_CHARS, '……')}`)
  if (!parts.length) parts.push('（这次没有拿到这节课的小结或字幕，只能靠题目本身和你的学科知识作答。）')
  return parts.join('\n\n')
}

function questionBlock(question) {
  const input = inputLabel(question.inputKind)
  const lines = [
    `第 ${question.index} 题（题型：${typeLabel(question.type)}${input ? `，作答控件：${input}` : ''}）`,
    question.stem ? `题干：${question.stem}` : '题干：（题干没有读到）',
  ]
  if (question.options.length) {
    lines.push(`选项：\n${question.options.map((option) => `${option.key}. ${normalized(option.label)}`).join('\n')}`)
  }
  return lines.join('\n')
}

function previousBlock(previous) {
  if (!previous) return ''
  const score = Number(previous.score)
  const maxScore = Number(previous.maxScore)
  const scoreText = Number.isFinite(score) && Number.isFinite(maxScore)
    ? `${score}/${maxScore}`
    : Number.isFinite(score) ? String(score) : '未知'
  const wrong = Array.isArray(previous.wrong) ? previous.wrong : []
  const lines = [`上一次的成绩：${scoreText}。`]
  if (wrong.length) {
    lines.push('上一次被判错的题（chosen 是你上次选的，correct 是系统公布的标准答案，为空表示没有公布）：')
    for (const item of wrong.slice(0, 50)) {
      const index = Number(item?.index)
      const label = Number.isFinite(index) ? `第 ${index} 题` : '其中一题'
      const stem = normalized(item?.stem).slice(0, 120)
      const chosen = normalized(item?.chosen) || '（没有读到）'
      const correct = normalized(item?.correct) || '（没有公布）'
      lines.push(`- ${label}${stem ? `《${stem}》` : ''}：你选了 ${chosen}，正确答案是 ${correct}`)
    }
  } else {
    lines.push('上一次没有拿到具体的错题记录（可能成绩没读全），所以把每一题都当成可能做错的题重新核对。')
  }
  return lines.join('\n')
}

function answerFormatRules() {
  return `作答格式（逐条照做）：
- answers 里每题一条，index 必须和题目编号完全一致，一题都不能漏。
- 单选题：choice 填选项 key（如 "B"）；判断题：choice 固定填 "true"（正确/对）或 "false"（错误/错），不管选项标的是什么 key，程序会自己映射；多选题：choice 用数组，如 ["A","C"]。
- 填空题、简答题：用 text 字段写答案文字，不要加选项、不要加引号；如果是计算题，把关键步骤和最终结果一起写。
- choice 和 text 按题型二选一，不要同一题都给。
- reason 写 1–2 句依据（课上讲的结论、公式、或推理），不要复述题干。
- confidence 是你对整份答案的把握，0 到 1 之间的小数；reasoning 用 2–4 句说整体思路。`
}

// ── 答题 ────────────────────────────────────────────────────────────────────

function quizPrompt(input, questions, extra = {}) {
  const attempt = Math.max(1, Number(input?.attempt) || 1)
  const meta = [
    input?.course?.title ? `课程：${input.course.title}` : '',
    input?.course?.teacher ? `教师：${input.course.teacher}` : '',
    input?.chapter?.title ? `章节：${input.chapter.title}` : '',
    input?.unit?.title ? `${unitLabel(input.unit)}：${input.unit.title}` : '',
  ].filter(Boolean).join('\n')

  const blocks = [
    meta,
    lessonBlock(input?.lesson),
    `这一次要作答的题目（共 ${questions.length} 题）：\n\n${questions.map(questionBlock).join('\n\n')}`,
  ]

  const attemptLines = []
  if (attempt >= 2) {
    attemptLines.push(
      `这是第 ${attempt} 次作答。这类测验一般只有两次机会，也就是说这是最后一次机会，这次必须全对（满分）才有效。`,
      previousBlock(input?.previous),
      `你要做的：
1. 先把上一次被判错的题逐道想清楚：是哪一步理解错了、选项里的哪个词把你带偏了，这次为什么应该选正确答案。如果系统公布了正确答案，就以它为准并想明白原因。
2. 再用同样的标准把全部题目重新做一遍：不光改错题，其他题也重新核对一遍。不要为了避开上一次的答案，反而把本来对的题改错。
3. 这次答案必须全部正确，没有第三次机会。`,
    )
  } else {
    attemptLines.push(
      '这是第 1 次作答。请认真作答：每题都先读完题干和全部选项，能联系上课堂内容的就联系，课堂没讲到的用学科知识推理。',
    )
  }

  if (extra.missing?.length) {
    attemptLines.push(
      `注意：你上一次的输出里，第 ${extra.missing.join('、')} 题没有给出能对上选项的答案（或答案格式不对）。`
      + '这次请把每一题都补全，格式严格按要求来。',
    )
  }

  blocks.push(attemptLines.join('\n\n'))
  if (questions.some((question) => question.type !== 'fill' && question.type !== 'short')) blocks.push(CHOICE_TIPS)
  blocks.push(answerFormatRules())
  return blocks.filter(Boolean).join('\n\n')
}

async function requestQuizAnswers(ctx, input, questions, extra = {}) {
  const parsed = await askJson(
    ctx,
    {
      system: QUIZ_SYSTEM,
      text: quizPrompt(input, questions, extra),
      reasoningEffort: effortOf(input?.settings),
      maxTokens: 32_000,
    },
    { schemaHint: QUIZ_SCHEMA, retries: 2 },
  )
  return { parsed, raw: rawOf(parsed) }
}

/**
 * 用模型作答一份测验/作业/考试。
 *
 * @param {any} ctx
 * @param {object} input 见 docs/contract.md 第 5 节；attempt=2 或带 previous 错题时会走「反思后重做」
 * @returns {Promise<{answers:Array<{index:number, choice?:string|string[], text?:string}>, confidence:number, reasoning:string, raw:string}>}
 */
export async function answerQuizWithModel(ctx, input) {
  const questions = normalizeQuestions(input?.questions)

  const first = await requestQuizAnswers(ctx, input, questions, {})
  const firstAligned = alignAnswers(questions, first.parsed)
  if (!firstAligned.missing.length) {
    return {
      answers: firstAligned.answers,
      confidence: normalizeConfidence(first.parsed?.confidence),
      reasoning: reasoningOf(first.parsed, firstAligned.answers),
      raw: first.raw,
    }
  }

  // 有漏题/格式不对：带着「缺了哪几题」再问一次全卷（不是只问那几题，保持整卷一致）。
  const second = await requestQuizAnswers(ctx, input, questions, { missing: firstAligned.missing })
  const secondAligned = alignAnswers(questions, second.parsed)
  // 第二次的输出优先；第二次仍缺的题退回第一次的答案（如果第一次其实能对上）。
  const merged = new Map()
  for (const answer of [...firstAligned.answers, ...secondAligned.answers]) merged.set(answer.index, answer)
  const stillMissing = questions.map((question) => question.index).filter((index) => !merged.has(index))
  if (stillMissing.length) {
    throw new Error(`模型没有为第 ${stillMissing.join('、')} 题给出可用答案，为避免乱答已经停下，请重试或手动作答。`)
  }
  const ordered = questions.map((question) => merged.get(question.index))
  return {
    answers: ordered,
    confidence: normalizeConfidence(second.parsed?.confidence ?? first.parsed?.confidence),
    reasoning: reasoningOf(second.parsed, ordered) || reasoningOf(first.parsed, ordered),
    raw: second.raw || first.raw,
  }
}

// ── 讨论区提问 ──────────────────────────────────────────────────────────────

function discussionPrompt(input, feedback) {
  const meta = [
    input?.course?.title ? `课程：${input.course.title}` : '',
    input?.chapter?.title ? `章节：${input.chapter.title}` : '',
    input?.lesson?.title ? `这节课：${input.lesson.title}` : '',
  ].filter(Boolean).join('\n')
  const summary = String(input?.lesson?.summary ?? '').trim()
  const transcript = String(input?.lesson?.transcript ?? '').trim()
  const teacherQuestion = String(input?.teacherQuestion ?? '').trim()
  const forumText = String(input?.forum?.pageText ?? '').trim()
  const forumTitles = Array.isArray(input?.forum?.recentTitles) ? input.forum.recentTitles.filter(Boolean).slice(0, 20) : []
  const material = [
    teacherQuestion ? `### 课程/老师给这一课次挂的讨论题（优先围绕它讨论）\n${teacherQuestion}` : '',
    summary ? `### 这节课的小结\n${truncate(summary, MAX_SUMMARY_CHARS, '……')}` : '',
    transcript ? `### 这节课的字幕/课堂记录（可能有识别错误）\n${truncate(transcript, MAX_TRANSCRIPT_CHARS, '……')}` : '',
    forumText
      ? `### 讨论区页面材料（可能有老师/助教的讨论题；只参考明确是老师或助教发的内容，不要把学生帖子当成老师提问）\n${forumTitles.length ? `最近主题：${forumTitles.join('；')}\n` : ''}${truncate(forumText, 5_000, '……')}`
      : '',
  ].filter(Boolean).join('\n\n')

  return `${meta}

${material || '（这节课没有拿到文字材料，就围绕这节课标题里最核心的概念来问。）'}

请你在课程综合讨论区发一个讨论帖，**优先针对老师在这节课里提出的问题**展开讨论。

要求：
0. 先找老师的问题，按顺序判断：
   - 如果材料里有「课程/老师给这一课次挂的讨论题」，直接针对这条讨论题写，不要另起炉灶；
   - 这节课的小结/字幕里，老师有没有明确提出某个问题、思考题，或反复强调「大家想一想」「为什么」「这个结论怎么理解」；
   - 讨论区材料里有没有老师/助教发布、置顶的讨论题（常在「课堂交流区」「老师答疑区」或标题里带「讨论」「思考」）；
   - 找到后，就针对这个问题写：标题点到老师的问题，正文先说你对这个问题的理解，再提出你的具体追问、补充或不同角度，不要另起炉灶泛泛提问；
   - 如果找不到老师明确的问题，就围绕本节最核心、最容易产生疑问的结论讨论，但不要假装老师问过、也不要编造老师说过的原话。
1. 先在心里想 3 个不同角度的候选（针对老师问题的不同理解、某个结论的适用条件/边界、和前后章节的联系、现实例子），每个候选给标题和正文，再选出最值得讨论的一条，把它的序号填在 best。
2. 标题不超过 30 个字，要具体、点到知识点或老师的问题。不要「关于……的思考」「浅谈……」「……之我见」这种作业腔。
3. 正文 80–200 个字，一个自然段：先点明你在回应哪个问题（老师的问题或本节核心问题），再简要说明自己已经理解到哪一步，最后把想问/想讨论的点说清楚。不要复述整节课，不要分点列提纲。
4. 语气中立、平实，只提问和讨论：不要表达情绪（不要写「我有点绕不过来」「好难」「崩溃」「终于懂了」这类），不诉苦、不卖萌、不夸张、不客套；也不要写学习心得或感慨。
5. 不要 AI 腔：不要「首先/其次/最后」「综上所述」「让我们一起」「希望对大家有帮助」「作为一个学生」；不要写学习心得或复盘。
6. 不要编造课堂里没讲过的术语、数据和事实；不要把学生的帖子当成老师的问题；不确定的东西就用疑问语气问，不要当结论说。
7. 只发一个帖子，所以 candidates 给 3 条，但 best 只能有 1 个。

${feedback ? `上一次的结果不合格：${feedback}\n请重新给 3 个候选，并严格满足「标题 ≤ 30 字、正文 80–200 字」。` : ''}`
}

/** 选择题里「以上都对/以上均不对」这种选项要最后判断，写进规则里减少模型选错。 */
const CHOICE_TIPS = `选择题的几条经验（照做）：
- 遇到「以上都对」「以上均不正确」这类选项，先把其他选项逐个判断完，再决定要不要选它。
- 多选题题干问「以下哪些」时，选项数量不固定：逐项确认它本身对不对，不确定的靠课堂结论和学科知识定。
- 判断题小心绝对化措辞（「一定」「必然」「都」「永远」），这类说法往往是错的，但仍要按题干本身判断。`

/** 标题清理：去 markdown 标记和首尾引号，超 30 字硬裁。 */
function clampTitle(raw) {
  let title = normalized(raw)
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^["'“”‘’「」『』【】]+|["'“”‘’「」『』【】]+$/g, '')
    .replace(/[。．.]+$/, '')
    .trim()
  if (charCount(title) > 30) title = sliceChars(title, 30).replace(/[，、；：,;:…]+$/, '').trim()
  return title
}

/** 正文清理：合并成一个自然段，超 200 字优先在句子/问号处收尾。 */
function clampContent(raw) {
  let content = normalized(String(raw ?? '').replace(/\r?\n+/g, ' '))
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim()
  const total = charCount(content)
  if (total <= 200) return content
  const chars = Array.from(content)
  const head = chars.slice(0, 200).join('')
  // 尽量保留完整的问句：200 字内最后一个问号/句号处收尾。
  const marks = ['？', '?', '！', '!', '。', '；', ';', '…']
  for (const mark of marks) {
    const at = head.lastIndexOf(mark)
    if (at >= 100) return head.slice(0, at + 1).trim()
  }
  return head.trim()
}

function sanitizePost(raw) {
  const title = clampTitle(raw?.title ?? raw?.name ?? raw?.subject)
  const content = clampContent(raw?.content ?? raw?.body ?? raw?.text ?? raw?.description)
  const titleLength = charCount(title)
  const contentLength = charCount(content)
  const ok = titleLength >= 5 && titleLength <= 30 && contentLength >= 80 && contentLength <= 200
  // 不合格时用「离理想长度 140 字多近」挑一个最好的兜底。
  const score = (contentLength >= 80 ? 20 : 0) - Math.abs(contentLength - 140)
  return { title, content, titleLength, contentLength, ok, score }
}

function extractCandidates(parsed) {
  const list = parsed?.candidates ?? parsed?.options ?? parsed?.posts ?? parsed?.items
  const candidates = []
  if (Array.isArray(list)) {
    for (const item of list) {
      candidates.push({ title: item?.title ?? item?.name, content: item?.content ?? item?.body ?? item?.text })
    }
  }
  if (parsed?.title || parsed?.content) {
    candidates.push({ title: parsed.title, content: parsed.content })
  }
  const best = Number(parsed?.best ?? parsed?.bestIndex ?? parsed?.pick)
  if (Number.isFinite(best) && best >= 1 && best <= candidates.length) {
    const chosen = candidates.splice(best - 1, 1)[0]
    candidates.unshift(chosen)
  }
  return candidates.map(sanitizePost).filter((post) => post.title && post.content)
}

/**
 * 每上完一节课，去综合讨论区提一个有深度的问题。
 *
 * @returns {Promise<{title:string, content:string}>} 标题 ≤30 字，正文 80–200 字
 */
export async function writeDiscussionQuestion(ctx, input) {
  let best = null
  let feedback = ''
  // 最多问 3 轮：第 1 轮正常，后两轮带着「上一版哪里不合格」重来（只在失败路径上多花调用）。
  for (let round = 0; round < 3; round += 1) {
    const parsed = await askJson(
      ctx,
      {
        system: DISCUSSION_SYSTEM,
        text: discussionPrompt(input, feedback),
        reasoningEffort: effortOf(input?.settings),
        maxTokens: 8_000,
      },
      { schemaHint: DISCUSSION_SCHEMA, retries: 1 },
    )
    const posts = extractCandidates(parsed)
    const perfect = posts.find((post) => post.ok)
    if (perfect) return { title: perfect.title, content: perfect.content }
    if (!posts.length) {
      feedback = '没有按要求的 JSON 结构给出 candidates 候选（title/content 都为空）。'
      continue
    }
    const first = posts[0]
    if (!best || first.score > best.score) best = first
    feedback = `标题「${first.title}」${first.titleLength} 字、正文 ${first.contentLength} 字，`
      + (first.titleLength < 5 || first.titleLength > 30 ? '标题必须 5–30 字；' : '')
      + (first.contentLength < 80 ? '正文太短，至少要有 80 字；' : '')
      + (first.contentLength > 200 ? '正文太长，要压到 200 字以内；' : '')
  }
  // 三轮都不完美：用已经裁剪到合法范围的最好一条；短到明显不正常就报错，不编。
  if (best && best.contentLength >= 60) return { title: best.title, content: best.content }
  throw new Error('模型没有给出可用的讨论问题，已经停下，不编造内容。')
}

// ── 课堂总结 ────────────────────────────────────────────────────────────────

function summaryPrompt(input) {
  const title = cleanString(input?.title, 200)
  const transcript = String(input?.transcript ?? '').trim()
  const kind = cleanString(input?.kind, 40)
  return `这节课的标题：${title || '（没有标题）'}${kind ? `（类型：${kind}）` : ''}

课堂材料：
${transcript ? truncate(transcript, MAX_TRANSCRIPT_FOR_SUMMARY, '……') : '（没有拿到字幕或文字记录，只能按标题概括，不要编造具体数据。）'}

请整理这节课的要点，供我自己做测验和向讨论区提问时参考。

要求：
1. summary：150–300 字，讲清这节课在讲什么、主线怎么走（先讲什么、再讲什么、结论是什么），不要逐句复述，不要写「老师讲了……然后就……」。
2. keyPoints：3–8 条，每条是一个具体的知识点（定义、公式、结论、方法、易错点），不要写「学习了……」「了解了……」这种空话。
3. confusion：1–2 句，说出一个真学生在这节课里最容易卡住或容易混淆的地方（比如两个相近概念的边界、公式的适用条件），我写讨论帖时要用。
4. 材料里没讲到的内容不要补；如果材料确实很少，就按标题能确定的范围写，并说明依据有限。`
}

/**
 * 把一节课的转写/摘要整理成答题和写讨论时用的上下文。
 *
 * @returns {Promise<{summary:string, keyPoints:string[], confusion:string}>}
 */
export async function summarizeLesson(ctx, input) {
  const parsed = await askJson(
    ctx,
    {
      system: SUMMARY_SYSTEM,
      text: summaryPrompt(input),
      reasoningEffort: effortOf(input?.settings),
      maxTokens: 8_000,
    },
    { schemaHint: SUMMARY_SCHEMA, retries: 2 },
  )

  const summary = sliceChars(parsed?.summary ?? parsed?.abstract ?? parsed?.overview, 1_200)
  if (!summary) throw new Error('模型没有返回课堂总结，已经停下。')

  const rawPoints = parsed?.keyPoints ?? parsed?.key_points ?? parsed?.points ?? parsed?.knowledgePoints
  const keyPoints = []
  for (const item of Array.isArray(rawPoints) ? rawPoints : []) {
    const point = normalized(typeof item === 'string' ? item : (item?.text ?? item?.point ?? item?.title))
    if (!point || keyPoints.includes(point)) continue
    keyPoints.push(sliceChars(point, 160))
    if (keyPoints.length >= 8) break
  }
  if (!keyPoints.length) keyPoints.push(sliceChars(summary, 80))

  const confusion = normalized(parsed?.confusion ?? parsed?.difficulty ?? parsed?.question)

  return { summary, keyPoints, confusion }
}

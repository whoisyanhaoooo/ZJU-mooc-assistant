/**
 * 任务执行器：把「视频课 / 测验 / 作业 / 考试 / 讨论」串成可上报进度的流程。
 *
 * 这里不直接碰 DSH 状态，也不自己建浏览器：页面、mooc 适配器、brain、进度回调都由 service.mjs 注入。
 * 所有阶段都用 onProgress({percent, phase, message, logLine}) 上报，前端靠它画实时进度条。
 */
import { messageOf, nowIso } from './util.mjs'

const QUIZ_KINDS = new Set(['quiz', 'homework'])
const FULL_MARK_TOLERANCE = 0.5

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('任务已取消')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(new Error('任务已取消')) }, { once: true })
  })
}

function isFullMark(result) {
  if (!result || typeof result.score !== 'number' || typeof result.maxScore !== 'number') return false
  return result.score >= result.maxScore - FULL_MARK_TOLERANCE
}

function scoreText(result) {
  if (!result || typeof result.score !== 'number') return '未读到分数'
  return `${result.score}/${typeof result.maxScore === 'number' ? result.maxScore : '?'}`
}

/** 把错误统一成带阶段的中文提示。 */
function stageError(stage, error) {
  const text = messageOf(error)
  const wrapped = new Error(`${stage}：${text}`)
  if (error?.dump) wrapped.dump = error.dump
  return wrapped
}

/**
 * 执行一个任务。
 * @returns {Promise<{ok:boolean, status:string, score?:number|null, maxScore?:number|null, detail:string, transcript?:string}>}
 */
export async function runTask(options) {
  const { task } = options
  if (!task) throw new Error('任务不存在')
  options.log?.('开始任务', task.title, task.kind)
  switch (task.kind) {
    case 'video':
      return runVideoTask(options)
    case 'quiz':
    case 'homework':
    case 'exam':
      return runQuizTask(options)
    case 'discussion':
      return runDiscussionTask(options)
    default:
      throw new Error(`还不支持这种任务类型：${task.kind}`)
  }
}

async function runVideoTask({ task, page, settings, mooc, brain, onProgress, signal, log, saveLessonNote }) {
  const unit = task.unit || { id: task.unitId, title: task.title, kind: 'video', url: task.url }
  if (!unit?.url && !unit?.id) throw new Error('这个视频任务没有可打开的地址，先刷新大纲再试。')

  onProgress({ percent: 4, phase: '打开视频', message: `正在打开「${unit.title}」…`, logLine: '打开视频页面' })
  let played
  try {
    played = await mooc.playVideoUnit(page, unit, {
      speed: Number(settings.videoSpeed) || 2,
      muted: settings.videoMuted === true,
      signal,
      onTick: tick => {
        const inner = Math.max(0, Math.min(100, Number(tick?.percent) || 0))
        onProgress({
          percent: 5 + inner * 0.8,
          phase: tick?.message || '正在上课',
          message: tick?.message || '',
        })
      },
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('任务已取消')
    throw stageError('播放视频失败', error)
  }
  if (signal?.aborted) throw new Error('任务已取消')

  onProgress({ percent: 86, phase: '整理笔记', message: '这节课看完了，正在整理要点…', logLine: '整理课堂要点' })
  const transcript = typeof played?.transcript === 'string' ? played.transcript.trim() : ''
  let note = { summary: '', keyPoints: [], confusion: '', transcript, at: nowIso() }
  try {
    if (transcript.length >= 80 || unit.title) {
      const summary = await brain.summarizeLesson({
        title: unit.title,
        transcript,
        kind: 'video',
        settings,
      })
      note = {
        summary: summary?.summary || '',
        keyPoints: Array.isArray(summary?.keyPoints) ? summary.keyPoints.slice(0, 8) : [],
        confusion: summary?.confusion || '',
        transcript,
        at: nowIso(),
      }
    }
  } catch (error) {
    log?.('课堂要点整理失败，继续用标题和字幕做上下文', messageOf(error))
    note.summary = transcript ? transcript.slice(0, 1200) : `这节课是「${unit.title}」。`
  }
  try { saveLessonNote?.(task.courseId, unit.id, note) } catch { /* ignore */ }

  onProgress({ percent: 100, phase: '完成', message: settings.autoDiscussAfterVideo ? '上课完成，准备去讨论区提问' : '上课完成' })
  const detail = played?.completed
    ? `已完整看完${transcript ? '，并读到字幕' : ''}${note.summary ? '，已整理课堂要点' : ''}`
    : `视频没有确认播完（${played?.message || '播放器没有报告结束'}），建议打开页面看看进度再重试`
  return { ok: played?.completed !== false, status: played?.completed === false ? 'needs-user' : 'done', detail, transcript }
}

async function runQuizTask({ task, page, settings, mooc, brain, onProgress, signal, log, getLessonNote, updateTask }) {
  const unit = task.unit || { id: task.unitId, title: task.title, kind: task.kind, url: task.url }
  const isExam = task.kind === 'exam'
  const allowSecond = isExam ? Number(settings.examAttempts) > 1 : settings.quizRepairSecondAttempt !== false
  const maxAttempts = Math.max(1, isExam ? Number(settings.examAttempts) || 1 : allowSecond ? 2 : 1)
  const note = getLessonNote?.(task.courseId, unit.id) || null
  let previous = null
  let best = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('任务已取消')
    const base = ((attempt - 1) / maxAttempts) * 100
    const span = 100 / maxAttempts
    const step = (inner, phase, message, logLine) =>
      onProgress({ percent: base + inner * span, phase, message, logLine })

    step(2, '进入题目', `打开「${unit.title}」…`, `第 ${attempt} 次进入题目`)
    try {
      await mooc.enterUnit(page, unit)
      await mooc.beginAttempt(page).catch(error => log?.('开始答题按钮不可用', messageOf(error)))
    } catch (error) {
      throw stageError('打开题目失败', error)
    }

    step(10, '读取题目', '正在读取题干和选项…')
    let quiz
    try {
      quiz = await mooc.readQuestions(page, unit)
    } catch (error) {
      throw stageError('读取题目失败', error)
    }
    if (!quiz?.questions?.length) {
      throw new Error('这一页没有找到题目。可能还没开始答题、页面结构变了，或者这次机会已经用完。请点「打开页面」手动看一下。')
    }
    step(20, '审题', `共 ${quiz.questions.length} 题，正在认真读题…`, `读取到 ${quiz.questions.length} 题`)

    let answer
    try {
      answer = await brain.answerQuizWithModel({
        course: { title: task.courseTitle, id: task.courseId },
        chapter: { title: task.chapterTitle, index: task.chapterIndex },
        unit: { kind: task.kind, title: unit.title },
        questions: quiz.questions,
        lesson: note,
        attempt,
        previous,
        settings,
      })
    } catch (error) {
      throw stageError('AI 作答失败', error)
    }
    if (!answer?.answers?.length) throw new Error('AI 没有给出答案，先别提交，可以重试一次。')

    step(55, '填写答案', '正在按题目填写答案…', attempt > 1 ? '第二次作答：已按反思修正答案' : '第一次作答')
    try {
      const applied = await mooc.applyAnswers(page, answer.answers)
      if (applied?.missing?.length) {
        log?.(`有 ${applied.missing.length} 题没填上：${applied.missing.join('、')}`)
      }
    } catch (error) {
      throw stageError('填写答案失败', error)
    }

    step(70, '提交', '正在提交…')
    try {
      await mooc.submitQuestions(page)
    } catch (error) {
      throw stageError('提交失败', error)
    }

    await sleep(1200, signal)
    step(82, '读取成绩', '正在读取这次成绩…')
    let result
    try {
      result = await mooc.readQuizResult(page)
    } catch (error) {
      throw stageError('读取成绩失败', error)
    }
    if (typeof result?.score !== 'number') {
      onProgress({ percent: 100, phase: '待确认', message: '提交完成，但没读到分数，请打开页面确认' })
      return {
        ok: false,
        status: 'needs-user',
        detail: result?.message || '提交了但没读到成绩，请打开页面确认一下',
        score: null,
        maxScore: null,
      }
    }

    best = result
    updateTask?.({ attempts: attempt, score: result.score, maxScore: result.maxScore, detail: `第 ${attempt} 次 ${scoreText(result)}` })
    log?.(`第 ${attempt} 次成绩 ${scoreText(result)}`)

    if (isFullMark(result)) {
      onProgress({ percent: 100, phase: '完成', message: `满分 ${scoreText(result)}` })
      return {
        ok: true,
        status: 'done',
        score: result.score,
        maxScore: result.maxScore,
        detail: attempt > 1 ? `第二次满分：${scoreText(result)}（第一次没满分，已反思重做）` : `一次满分：${scoreText(result)}`,
      }
    }

    if (attempt < maxAttempts) {
      previous = {
        score: result.score,
        maxScore: result.maxScore,
        wrong: Array.isArray(result.wrong) ? result.wrong : [],
      }
      const wrongCount = previous.wrong.length
      onProgress({
        percent: base + 92,
        phase: '反思',
        message: wrongCount ? `没满分，正在反思 ${wrongCount} 道错题…` : '没满分，正在反思并准备第二次…',
        logLine: `第 ${attempt} 次 ${scoreText(result)}，准备第二次`,
      })
      await sleep(800, signal)
      continue
    }
  }

  const finalText = scoreText(best)
  onProgress({ percent: 100, phase: '待确认', message: `没有拿到满分：${finalText}` })
  return {
    ok: false,
    status: 'needs-user',
    score: best?.score ?? null,
    maxScore: best?.maxScore ?? null,
    detail: `机会用完了，最好成绩 ${finalText}，没有满分。可以打开页面看看错题解析。`,
  }
}

async function runDiscussionTask({ task, page, settings, mooc, brain, onProgress, signal, log, getLessonNote }) {
  const unit = task.unit || { id: task.unitId, title: task.title, kind: 'discussion', url: task.url }
  const note = getLessonNote?.(task.courseId, unit.id) || null
  const course = { id: task.courseId, title: task.courseTitle, url: task.courseUrl || '' }

  onProgress({ percent: 6, phase: '打开讨论区', message: '正在打开课程综合讨论区…', logLine: '打开综合讨论区' })
  try {
    await mooc.openForum(page, course)
  } catch (error) {
    throw stageError('打开讨论区失败', error)
  }
  if (signal?.aborted) throw new Error('任务已取消')

  // 顺手读一下讨论区页面：老师/助教可能在这里置顶讨论题，生成问题时优先针对它
  let forum = null
  try {
    forum = await mooc.readForumContext(page)
  } catch { /* 读不到就只用课堂材料 */ }

  onProgress({ percent: 26, phase: '想问题', message: '正在想一个真正想问的问题…' })
  let post
  try {
    post = await brain.writeDiscussionQuestion({
      course,
      chapter: { title: task.chapterTitle, index: task.chapterIndex },
      lesson: {
        title: unit.title,
        summary: note?.summary || '',
        transcript: note?.transcript || '',
      },
      forum,
      teacherQuestion: String(task.unit?.discussionTitle || '').trim(),
      kind: 'question',
      settings,
    })
  } catch (error) {
    throw stageError('生成讨论问题失败', error)
  }
  const title = String(post?.title || '').trim().replace(/\s+/g, ' ').slice(0, 30)
  const content = String(post?.content || '').trim()
  if (!title || !content) throw new Error('AI 没有给出像样的讨论问题，先不发了，稍后重试。')

  onProgress({ percent: 62, phase: '发帖', message: `正在发布：${title}`, logLine: `发帖：${title}` })
  try {
    const result = await mooc.postDiscussion(page, course, { title, content })
    if (!result?.ok) throw new Error(result?.message || '讨论区没有确认发布成功')
    onProgress({ percent: 100, phase: '完成', message: '已在综合讨论区发出问题' })
    log?.(`讨论区发帖成功：${title}`)
    return { ok: true, status: 'done', detail: `已在综合讨论区提问：${title}` }
  } catch (error) {
    throw stageError('发布讨论失败', error)
  }
}

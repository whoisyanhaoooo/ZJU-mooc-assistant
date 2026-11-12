/**
 * 新版中国大学 MOOC（2026 起 /mooc/learn/... 的 Next.js 站）适配。
 *
 * 旧版 mooc.mjs 是按老 SPA 写的；现在 MOOC 课程：课件 / 测验与作业 / 考试 / 讨论区都换成了新前端，
 * 只有「答题页」仍然是老 SPA（/learn/<short>?hiddenMenu=1#/learn/quiz?id=…）。
 * SPOC 课程仍然整套是老 SPA（/spoc/learn/<short>?tid=…#/learn/...）。
 *
 * 本模块只做「新版 MOOC + 老版 SPOC 的课程列表 / 章节大纲 / 视频 / 讨论区」，
 * 由 host/mooc.mjs 委托调用；答题相关仍走 mooc.mjs 里已有的老 SPA 实现。
 *
 * 实测依据（2026-11-10，登录账号真实页面）：
 * - 课程列表：POST /web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc?csrfKey=…
 *   body: type=30&p=1&psize=8&courseType=1（MOOC）/ courseType=2（SPOC）
 * - 新版课件目录：details.course-outline-chapter[data-chapter-id] +
 *   a[data-testid=course-outline-unit-link][data-unit-id][data-unit-type]
 * - 新版测验与作业：section.learn-assessment-week > h3 + .learn-assessment-card
 * - 新版考试：.learn-exam-card[data-legacy-exam-card]（链接 #/learn/examObject?…）
 * - 新版讨论区：/mooc/learn/<short>/forum?tid=…；发帖页 /mooc/learn/<short>/forum/topic?tid=…
 * - SPOC 课件目录：.m-learnChapterNormal 里 .j-titleName + .sourceList .lsicon[data-cid]
 * - SPOC 测验：.u-quizHwListItem（.j-name/.j-submitTime/.j-quizBtn）
 * - SPOC 考试：.u-quizHwListItem.eaxmListItem（id=考试 id）
 *
 * 重要：新版页面是「可见才加载」的，读数据前必须把标签页切到前台（page.activate）。
 */
const BASE = 'https://www.icourse163.org'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function norm(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

export function absoluteUrl(href) {
  const value = String(href ?? '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('//')) return `https:${value}`
  return BASE + (value.startsWith('/') ? value : `/${value}`)
}

/** 课程 URL 是否属于新版 MOOC 站。 */
export function isNewCourse(course) {
  return /\/mooc\/learn\//.test(String(course?.url || '')) || course?.site === 'new'
}

/** 单元 URL 是否属于新版 MOOC 站。 */
export function isNewUnit(unit) {
  return /\/mooc\/learn\//.test(String(unit?.url || '')) || unit?.site === 'new'
}

export function shortNameOf(course) {
  const fromUrl = String(course?.url || '').match(/\/mooc\/learn\/([A-Za-z0-9]+-\d+)/)
    || String(course?.url || '').match(/\/spoc\/learn\/([A-Za-z0-9]+-\d+)/)
  return fromUrl ? fromUrl[1] : String(course?.shortName || course?.id || '')
}

export function termIdOf(course) {
  const fromUrl = String(course?.url || '').match(/[?&]tid=(\d+)/)
  return fromUrl ? fromUrl[1] : String(course?.termId || '')
}

const DOM_HELPERS = String.raw`
  const norm = value => String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = el => el ? norm(el.innerText || el.textContent || '') : '';
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const isVisible = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.01;
  };
  const setInputValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const clickEl = el => { if (!el) return false; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click(); return true; };
`

async function run(page, body) {
  return page.eval(`(() => { ${DOM_HELPERS} ${body} })()`)
}

async function activate(page) {
  try { await page.activate?.() } catch { /* ignore */ }
}

async function waitSelector(page, selector, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const found = await page.eval(`Boolean(document.querySelector(${JSON.stringify(String(selector))}))`)
      if (found) return true
    } catch { /* 页面可能在切换，继续等 */ }
    await sleep(500)
  }
  return false
}

async function failWith(page, message) {
  let dump = null
  try {
    const url = await page.url()
    const text = await page.text()
    dump = { url, text: text.slice(0, 2000) }
  } catch { /* ignore */ }
  const error = new Error(`${message}${dump?.url ? `（当前页面：${dump.url}）` : ''}`)
  if (dump) error.dump = dump
  return error
}

function classifyText(text) {
  const value = String(text || '')
  if (/考试|期末考|期中|exam/i.test(value)) return 'exam'
  if (/测验|测试|随堂测|quiz|test/i.test(value)) return 'quiz'
  if (/作业|编程练习|编程题|homework|assignment/i.test(value)) return 'homework'
  if (/讨论|话题|交流|discussion|forum/i.test(value)) return 'discussion'
  if (/视频|课时|lecture|video/i.test(value)) return 'video'
  if (/文档|课件|讲义|阅读|pdf|doc/i.test(value)) return 'doc'
  return 'other'
}

// ---------------------------------------------------------------------------
// 我的课程（RPC，一次拿 MOOC + SPOC）
// ---------------------------------------------------------------------------

export async function readMyCourses(page, opts = {}) {
  const onlySpoc = opts?.onlySpoc === true
  await activate(page)
  const current = String(await page.url().catch(() => '') || '')
  if (!/icourse163\.org/.test(current)) {
    await page.goto(`${BASE}/home.htm`, { waitMs: 3_000 })
    await activate(page)
    await sleep(1_000)
  }
  const courseTypes = onlySpoc ? [2] : [1, 2]
  const courses = []
  const seen = new Set()
  let lastError = ''
  let success = false
  for (const courseType of courseTypes) {
    const body = `type=30&p=1&psize=30&courseType=${courseType}`
    const response = await page.eval(`(async () => {
      const csrf = (document.cookie.match(/NTESSTUDYSI=([^;]+)/) || [])[1] || ''
      try {
        const res = await fetch('/web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc?csrfKey=' + encodeURIComponent(csrf), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json, text/plain, */*' },
          body: ${JSON.stringify(body)},
        })
        const text = await res.text()
        try { return JSON.parse(text) } catch { return { code: res.status, raw: text.slice(0, 300) } }
      } catch (error) { return { code: -1, message: String(error && error.message || error) } }
    })()`).catch(error => ({ code: -1, message: String(error?.message || error) }))

    if (response?.code !== 0) {
      lastError = response?.message || response?.raw || `接口返回 code=${response?.code}`
      continue
    }
    success = true
    const list = response?.result?.result
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const course = courseFromItem(item, courseType)
      if (!course || seen.has(course.id)) continue
      seen.add(course.id)
      courses.push(course)
    }
  }
  if (!success) throw await failWith(page, `读取「我的课程」失败：登录状态可能失效（${lastError || '接口没有返回数据'}）。点「登录」重新登录后再试。`)
  // MOOC 在前、SPOC 在后，同类型按标题稳定排序
  courses.sort((a, b) => Number(a.spoc) - Number(b.spoc) || String(a.title).localeCompare(String(b.title), 'zh'))
  return courses
}

function courseFromItem(item, courseType) {
  if (!item || typeof item !== 'object') return null
  const term = item.termPanel && typeof item.termPanel === 'object' ? item.termPanel : {}
  const termId = Number(term.id) || ''
  const schoolShortName = String(item.schoolPanel?.shortName || '').trim()
  const courseId = Number(item.id) || ''
  // 学习页地址里的 key 是「学校简称-课程数字 id」（例如 ZJU-1003315004），
  // 不是接口里的 shortName（那是 1001ZJU021A 这种课程代码）。查不到学校简称时退回课程代码。
  const key = schoolShortName && courseId ? `${schoolShortName}-${courseId}` : (String(item.shortName || '').trim() || (courseId ? `course-${courseId}` : ''))
  if (!key) return null
  const spoc = courseType === 2 || Number(item.mode) === 10
  const formatDate = millis => {
    const value = Number(millis)
    if (!Number.isFinite(value) || value <= 0) return ''
    const date = new Date(value)
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
  }
  const start = formatDate(term.startTime)
  const end = formatDate(term.endTime)
  const lessons = Number(term.lessonsCount) || Number(item.releaseCount) || 0
  const learned = Number(item.learnedCount) || 0
  return {
    id: key,
    title: norm(item.name) || key,
    teacher: '',
    term: start || end ? `${start || '?'} ~ ${end || '?'}` : '',
    cover: String(item.imgUrl || term.bigPhotoUrl || ''),
    url: spoc
      ? `${BASE}/spoc/learn/${key}?tid=${termId}#/learn/content`
      : `${BASE}/mooc/learn/${key}/content?tid=${termId}`,
    spoc,
    state: end && Date.parse(end) < Date.now() ? '已结束' : '进行中',
    progress: lessons > 0 ? Math.max(0, Math.min(1, learned / lessons)) : null,
    school: norm(item.schoolPanel?.name),
    // 内部字段：大纲 / 讨论区需要
    shortName: key,
    termId: String(termId),
    courseId: String(courseId),
    // SPOC 的课件/视频来自「源课程」，大纲接口要用源课程 termId
    sourceTermId: String(term.fromTermId || ''),
    site: spoc ? 'legacy' : 'new',
  }
}

// ---------------------------------------------------------------------------
// 章节大纲
// ---------------------------------------------------------------------------

export async function readOutline(page, course) {
  const newSite = isNewCourse(course)
  const contentTermId = newSite ? termIdOf(course) : String(course?.sourceTermId || termIdOf(course))
  // 目录优先走站点接口（getLastLearnedMocTermDto）：章节/课次/单元一次拿全，
  // 不用一个个展开懒加载的折叠面板，也不会漏掉后面的周。
  let chapters = []
  if (contentTermId) {
    try {
      const raw = await fetchTermOutline(page, contentTermId)
      chapters = chaptersFromTerm(raw, course, newSite)
    } catch { /* 接口失败再退回 DOM */ }
  }
  if (!chapters.length) {
    return newSite ? readNewOutlineDom(page, course) : readLegacyOutlineDom(page, course)
  }
  if (newSite) {
    await attachNewAssessments(page, course, chapters)
    await attachNewExams(page, course, chapters)
  } else {
    await attachLegacyAssessments(page, course, chapters)
    await attachLegacyExams(page, course, chapters)
    // SPOC 的学期接口经常不返回讨论单元，必须从课件页 DOM 再补一次
    try {
      const rawUnits = await scrapeLegacyContentUnits(page, course)
      applyLegacyDiscussionFlags(chapters, rawUnits)
    } catch { /* DOM 也读不到就保持接口结果 */ }
  }
  // 源课程里可能留一个空的「期末考试」章节，没有单元就不用展示
  return {
    courseId: course?.id,
    fetchedAt: new Date().toISOString(),
    source: 'api',
    // 老版 SPOC 的讨论标记是追加在 DOM 读取之后补上的，版本号让服务层知道要不要重新读
    discussionFlagVersion: 3,
    chapters: chapters.filter(chapter => chapter.units.length),
  }
}

/** 老版 SPOC 课件页：按课次抓视频单元 id 和讨论单元标题（接口有时不返回讨论单元）。 */
async function scrapeLegacyContentUnits(page, course) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  const contentUrl = `${BASE}/spoc/learn/${shortName}?tid=${termId}#/learn/content`
  await activate(page)
  await page.goto(contentUrl, { waitMs: 4_000 })
  await activate(page)
  await sleep(1_200)
  if (!(await waitSelector(page, '.m-learnChapterNormal', 30_000))) return []
  return run(page, `
    return [...document.querySelectorAll('.m-learnChapterNormal')].map((chapter, index) => ({
      title: textOf(q('.j-titleName', chapter)) || textOf(q('h3', chapter)) || ('第' + (index + 1) + '周'),
      units: [...chapter.querySelectorAll('.lessonBox .u-learnLesson, .u-learnLesson')].flatMap(lesson => {
        const lessonTitle = textOf(q('.j-name', lesson));
        return [...lesson.querySelectorAll('.sourceList .lsicon[data-cid]')].map(item => ({
          id: String(item.getAttribute('data-cid') || ''),
          title: norm(item.getAttribute('title') || textOf(item) || lessonTitle),
          tag: textOf(q('.tag', item)),
          className: String(item.className || ''),
          lessonTitle,
        }));
      }),
    }));
  `)
}

/** 把 DOM 里读到的讨论单元挂到同一课次的最后一个视频上。 */
export function applyLegacyDiscussionFlags(chapters, rawChapters) {
  const byId = new Map()
  for (const chapter of chapters || []) {
    for (const unit of chapter.units || []) byId.set(String(unit.id), unit)
  }
  let flagged = 0
  for (const chapter of rawChapters || []) {
    const groups = new Map()
    for (const unit of chapter.units || []) {
      const key = String(unit.lessonTitle || '')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(unit)
    }
    for (const list of groups.values()) {
      const discussions = list.filter(unit => /讨论/.test(unit.tag || '') || /讨论/.test(unit.title || ''))
      if (!discussions.length) continue
      const videos = list
        .filter(unit => /视频/.test(unit.tag || '') || /视频/.test(unit.className || ''))
        .map(unit => byId.get(String(unit.id)))
        .filter(unit => unit && unit.kind === 'video')
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      const target = videos[videos.length - 1]
      if (!target) continue
      target.hasDiscussion = true
      target.discussionUnitId = String(discussions[0].id || target.discussionUnitId || '')
      target.discussionTitle = discussions
        .map(unit => String(unit.title || '').replace(/^讨论\s*[:：]?\s*/, '').trim())
        .filter(Boolean)
        .join('；')
        .slice(0, 160)
      flagged += 1
    }
  }
  return flagged
}

/** 站点接口：拿一个 term 的完整章节结构。 */
async function fetchTermOutline(page, termId) {
  const current = String(await page.url().catch(() => '') || '')
  if (!/icourse163\.org/.test(current)) {
    await page.goto(`${BASE}/home.htm`, { waitMs: 3_000 })
    await activate(page)
    await sleep(800)
  }
  const response = await page.eval(`(async () => {
    const csrf = (document.cookie.match(/NTESSTUDYSI=([^;]+)/) || [])[1] || ''
    try {
      const res = await fetch('/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json, text/plain, */*' },
        body: ${JSON.stringify(`termId=${termId}`)},
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return { code: res.status, raw: text.slice(0, 200) } }
    } catch (error) { return { code: -1, message: String(error && error.message || error) } }
  })()`)
  if (response?.code !== 0) throw new Error(`章节接口失败（${response?.message || response?.code || '未知'}）`)
  const chapters = response?.result?.mocTermDto?.chapters
  if (!Array.isArray(chapters)) throw new Error('章节接口没有返回 chapters')
  return chapters
}

/** 把接口返回的章节结构转成任务用的章节/单元（只保留视频/文档/讨论）。 */
export function chaptersFromTerm(rawChapters, course, newSite) {
  const key = shortNameOf(course)
  const termId = termIdOf(course)
  const learnUrl = `${BASE}/spoc/learn/${key}?tid=${termId}#/learn/content`
  const formatClock = seconds => {
    const value = Math.round(Number(seconds) || 0)
    return value > 0 ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : ''
  }
  const seen = new Set()
  const chapters = []
  rawChapters.forEach((chapter, index) => {
    const units = []
    let unitOrder = 0
    for (const lesson of chapter.lessons || []) {
      const lessonUnits = lesson.units || []
      // 课次里 contentType=6 是老师给这一课次挂的讨论任务；没有这种单元的课次不需要讨论
      const discussionUnit = lessonUnits.find(unit => Number(unit.contentType) === 6 && (unit.name || unit.nameAlias))
      const lessonDiscussionTitle = discussionUnit ? String(discussionUnit.name || discussionUnit.nameAlias || '').trim() : ''
      let lastVideoId = ''
      for (const unit of lessonUnits) {
        const contentType = Number(unit.contentType)
        // 3 = 章节内的测验，统一由「测验与作业」页列出，避免重复
        if (contentType === 3) continue
        const id = String(unit.id || '')
        if (!id || seen.has(id)) continue
        const durationSeconds = Number(unit.durationInSeconds) || 0
        const completePercent = Number(unit.completePercent) || 0
        let kind = 'other'
        let url = ''
        let clickSelector = ''
        if (contentType === 6) {
          kind = 'discussion'
        } else if (durationSeconds > 0) {
          kind = 'video'
          if (newSite) {
            url = `${BASE}/mooc/learn/${key}/content/${unit.lessonId}?tid=${termId}&unitId=${unit.id}&chapterId=${unit.chapterId}`
          } else {
            clickSelector = `.lsicon[data-cid="${unit.id}"]`
          }
        } else {
          kind = 'doc'
          if (!newSite) clickSelector = `.lsicon[data-cid="${unit.id}"]`
        }
        if (kind === 'other' || kind === 'discussion') continue
        seen.add(id)
        if (kind === 'video') lastVideoId = id
        units.push({
          id,
          title: unit.name || unit.nameAlias || '未命名单元',
          kind,
          hasDiscussion: false,
          discussionUnitId: '',
          discussionTitle: '',
          url,
          clickSelector,
          clickText: unit.name || '',
          learnUrl,
          // 站点里课次/单元的真实顺序，前端列表必须按它排，不能按标题字符串
          order: unitOrder++,
          duration: formatClock(durationSeconds),
          deadline: '',
          status: completePercent >= 0.995 ? '已完成' : completePercent > 0 ? `已学 ${Math.round(completePercent * 100)}%` : '',
          score: '',
          site: newSite ? 'new' : 'legacy',
        })
      }
      // 讨论挂在这个课次的最后一个视频后面，而不是每个视频都生成一个讨论任务
      if (discussionUnit && lastVideoId) {
        const target = units.find(unit => unit.id === lastVideoId)
        if (target) {
          target.hasDiscussion = true
          target.discussionUnitId = String(discussionUnit.id || '')
          target.discussionTitle = lessonDiscussionTitle
        }
      }
    }
    chapters.push({
      id: String(chapter.id || `chapter-${index + 1}`),
      index: index + 1,
      title: chapter.name || `第${index + 1}周`,
      units,
    })
  })
  return chapters
}

/** 新版：把「测验与作业」挂到对应周的章节上。 */
async function attachNewAssessments(page, course, chapters) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  try {
    await activate(page)
    await page.goto(`${BASE}/mooc/learn/${shortName}/assessments?tid=${termId}`, { waitMs: 4_000 })
    await activate(page)
    if (!(await waitSelector(page, '.learn-assessment-card:not([data-skeleton-row])', 30_000))) return
    const sections = await run(page, `
      return [...document.querySelectorAll('.learn-assessment-week')].map(section => ({
        week: textOf(q('h3', section)),
        cards: [...section.querySelectorAll('.learn-assessment-card')].map(card => {
          const link = q('a[data-assessment-href], a[href*="quiz?id="], a[href*="quiz"]', card);
          const href = link ? (link.getAttribute('href') || '') : '';
          const idMatch = href.match(/[?&#]id=(\\d+)/);
          return {
            title: textOf(q('.learn-assessment-title', card)),
            deadline: textOf(q('.learn-assessment-deadline', card)).replace(/^截止时间[:：]\\s*/, ''),
            href,
            quizId: idMatch ? idMatch[1] : '',
          };
        }).filter(card => card.title),
      })).filter(section => section.cards.length);
    `)
    for (const section of sections) {
      const week = norm(section.week)
      let target = week ? chapters.find(chapter => chapter.title.includes(week) || week.includes(chapter.title)) : null
      if (!target) {
        target = { id: `assess-${week || 'quiz'}`, index: chapters.length + 1, title: week ? `测验与作业 · ${week}` : '测验与作业', units: [] }
        chapters.push(target)
      }
      for (const card of section.cards) {
        if (target.units.some(unit => unit.title === card.title)) continue
        target.units.push({
          id: `quiz-${card.quizId || card.title}`,
          title: card.title,
          kind: 'quiz',
          url: absoluteUrl(card.href),
          duration: '',
          deadline: card.deadline,
          status: '',
          score: '',
          site: 'new',
        })
      }
    }
  } catch { /* 没有测验的课程很常见 */ }
}

/** 新版：考试。 */
async function attachNewExams(page, course, chapters) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  try {
    await activate(page)
    await page.goto(`${BASE}/mooc/learn/${shortName}/exams?tid=${termId}`, { waitMs: 4_000 })
    await activate(page)
    if (!(await waitSelector(page, '.learn-exam-card:not([data-skeleton-row])', 30_000))) return
    const exams = await run(page, `
      return [...document.querySelectorAll('.learn-exam-card')].map(card => {
        const link = q('a[href*="examObject"], a[href*="exam"]', card);
        const summary = textOf(q('.learn-exam-card-summary', card));
        const deadlineMatch = summary.match(/截止时间[:：]\\s*([^·]+)/);
        return {
          title: textOf(q('strong', card)) || textOf(q('.learn-exam-card-title', card)),
          href: link ? (link.getAttribute('href') || '') : '',
          eid: String(card.getAttribute('data-legacy-exam-card') || ''),
          deadline: deadlineMatch ? norm(deadlineMatch[1]) : '',
        };
      }).filter(exam => exam.title);
    `)
    if (!exams.length) return
    let target = chapters.find(chapter => chapter.title === '考试')
    if (!target) {
      target = { id: 'exams', index: chapters.length + 1, title: '考试', units: [] }
      chapters.push(target)
    }
    exams.forEach((exam, index) => {
      if (target.units.some(unit => unit.title === exam.title)) return
      target.units.push({
        id: `exam-${exam.eid || index + 1}`,
        title: exam.title,
        kind: 'exam',
        url: absoluteUrl(exam.href),
        duration: '',
        deadline: exam.deadline,
        status: '',
        score: '',
        site: 'new',
      })
    })
  } catch { /* 没有考试的课程很常见 */ }
}

/** SPOC：测验与作业（周标题在 .m-chapterQuizHwItem 里）。 */
async function attachLegacyAssessments(page, course, chapters) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  const base = `${BASE}/spoc/learn/${shortName}?tid=${termId}`
  try {
    await activate(page)
    await page.goto(`${base}#/learn/testlist`, { waitMs: 4_000 })
    await activate(page)
    if (!(await waitSelector(page, '.u-quizHwListItem', 25_000))) return
    const items = await run(page, `
      return [...document.querySelectorAll('.u-quizHwListItem')].map(item => {
        const holder = item.closest('.m-chapterQuizHwItem');
        const nameNode = q('.j-name', item);
        const title = textOf(nameNode);
        return {
          title,
          week: holder ? textOf(q('.j-titleName', holder)) : '',
          deadline: textOf(q('.j-submitTime', item)).replace(/^截止时间[:：]\\s*/, ''),
          score: textOf(q('.j-validScore', item)),
          attempts: textOf(q('.j-submitCount', item)),
        };
      }).filter(item => item.title);
    `)
    for (const item of items) {
      const week = norm(item.week)
      let target = week ? chapters.find(chapter => chapter.title.includes(week) || week.includes(chapter.title)) : null
      if (!target) {
        target = { id: `assess-${week || 'quiz'}`, index: chapters.length + 1, title: week ? `测验与作业 · ${week}` : '测验与作业', units: [] }
        chapters.push(target)
      }
      if (target.units.some(unit => unit.title === item.title)) continue
      const kind = classifyText(item.title)
      target.units.push({
        id: `quiz-${norm(item.title)}`,
        title: item.title,
        kind: kind === 'exam' ? 'exam' : kind === 'homework' ? 'homework' : 'quiz',
        // 老 SPA 的测试在「测验与作业」列表页里点「前往测验」
        url: `${base}#/learn/testlist`,
        clickSelector: '',
        clickText: item.title,
        clickScript: `const wanted = ${JSON.stringify(item.title)};
          const row = [...document.querySelectorAll('.u-quizHwListItem')].find(el => {
            const name = el.querySelector('.j-name');
            return name && (name.textContent || '').trim() === wanted;
          });
          if (!row) return false;
          const button = row.querySelector('.j-quizBtn, a.j-quizBtn, a, button');
          if (button) { button.click(); return true; }
          const head = row.querySelector('.j-titleBox');
          if (head) { head.click(); return true; }
          return false;`,
        duration: '',
        deadline: item.deadline,
        status: /得分/.test(item.score) ? `已作答（${norm(item.score)}）` : '',
        score: norm(item.score),
        site: 'legacy',
      })
    }
  } catch { /* ignore */ }
}

/** SPOC：考试。 */
async function attachLegacyExams(page, course, chapters) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  const base = `${BASE}/spoc/learn/${shortName}?tid=${termId}`
  try {
    await activate(page)
    await page.goto(`${base}#/learn/examlist`, { waitMs: 4_000 })
    await activate(page)
    if (!(await waitSelector(page, '.u-quizHwListItem.eaxmListItem', 25_000))) return
    const exams = await run(page, `
      return [...document.querySelectorAll('.u-quizHwListItem.eaxmListItem')].map((item, index) => ({
        id: item.id || ('exam-' + (index + 1)),
        title: textOf(q('.j-name', item)) || ('考试 ' + (index + 1)),
        total: textOf(q('.j-totalScore', item)),
        detail: textOf(q('.j-detail', item)).slice(0, 400),
        status: textOf(q('.j-validScore', item)),
      })).filter(exam => exam.title);
    `)
    if (!exams.length) return
    let target = chapters.find(chapter => chapter.title === '考试')
    if (!target) {
      target = { id: 'exams', index: chapters.length + 1, title: '考试', units: [] }
      chapters.push(target)
    }
    for (const exam of exams) {
      if (target.units.some(unit => unit.title === exam.title)) continue
      const deadlineMatch = exam.detail.match(/(?:截止|提交截止)时间[:：]\s*([0-9/\- :]+)/)
      target.units.push({
        id: `exam-${exam.id}`,
        title: exam.title,
        kind: 'exam',
        // 老 SPA 的考试在「考试」列表页里展开/进入
        url: `${base}#/learn/examlist`,
        clickSelector: `[id="${exam.id}"]`,
        clickText: exam.title,
        duration: '',
        deadline: deadlineMatch ? norm(deadlineMatch[1]) : '',
        status: '',
        score: exam.status,
        site: 'legacy',
      })
    }
  } catch { /* ignore */ }
}

/** 新版 MOOC：课件目录 + 测验与作业 + 考试（DOM 兜底）。 */
async function readNewOutlineDom(page, course) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  if (!shortName) throw await failWith(page, '这门课缺少课程标识（shortName），没法读取章节大纲。')
  const contentUrl = String(course?.url || '') || `${BASE}/mooc/learn/${shortName}/content?tid=${termId}`

  await activate(page)
  await page.goto(contentUrl, { waitMs: 4_000 })
  await activate(page)
  await sleep(1_200)
  if (!(await waitSelector(page, '.course-outline-chapter', 30_000))) {
    throw await failWith(page, '没读到新版课件目录（.course-outline-chapter）：可能课程还没发布内容，或者需要在这个浏览器窗口里重新登录。')
  }

  const rawChapters = await run(page, `
    // 新版目录的其它章节是折叠懒加载：先全部展开再读，否则只有第 1 章有单元。
    for (const details of qa('details.course-outline-chapter')) {
      if (!details.open) { const summary = details.querySelector('summary'); if (summary) summary.click(); }
    }
    return [...document.querySelectorAll('details.course-outline-chapter')].map((details, index) => {
      const title = textOf(q('.course-outline-chapter-title-text', details)) || ('第' + (index + 1) + '周');
      const units = [];
      for (const link of qa('[data-testid="course-outline-unit-link"], a[data-unit-id]', details)) {
        const typeText = textOf(q('span.rounded-full', link));
        const titleText = textOf(q('span.truncate', link)) || textOf(q('span.min-w-0', link));
        const unitType = String(link.getAttribute('data-unit-type') || '');
        const href = link.getAttribute('href') || '';
        const unitId = String(link.getAttribute('data-unit-id') || '');
        if (!titleText || /^(继续学习|开始学习|去学习)$/.test(titleText)) continue;
        const statusIcon = details.querySelector('[data-progress-state]');
        units.push({
          id: unitId,
          title: titleText.slice(0, 200),
          unitType,
          typeText,
          url: href,
          status: statusIcon ? String(statusIcon.getAttribute('data-progress-state') || '') : '',
        });
      }
      // 同一个 unit-id 可能同时出现在「继续学习」和单元链接里，按 id 去重
      const seen = new Set();
      const uniqueUnits = units.filter(unit => {
        if (!unit.id) return true;
        if (seen.has(unit.id)) return false;
        seen.add(unit.id);
        return true;
      });
      return { id: String(details.getAttribute('data-chapter-id') || ('chapter-' + (index + 1))), index: index + 1, title, units: uniqueUnits };
    });
  `)
  await sleep(500)

  const chapters = rawChapters.map(chapter => ({
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    units: chapter.units.map(unit => ({
      id: unit.id || `${chapter.id}-${chapter.units.indexOf(unit) + 1}`,
      title: unit.title,
      kind: unit.unitType ? classifyText(`${unit.unitType} ${unit.typeText} ${unit.title}`) : classifyText(`${unit.typeText} ${unit.title}`),
      url: absoluteUrl(unit.url),
      duration: '',
      deadline: '',
      status: unit.status === 'finished' || unit.status === 'completed' ? '已完成' : '',
      score: '',
      site: 'new',
    })),
  }))

  // ---- 测验与作业 ----
  try {
    await page.goto(`${BASE}/mooc/learn/${shortName}/assessments?tid=${termId}`, { waitMs: 4_000 })
    await activate(page)
    if (await waitSelector(page, '.learn-assessment-card:not([data-skeleton-row])', 30_000)) {
      const sections = await run(page, `
        return [...document.querySelectorAll('.learn-assessment-week')].map(section => ({
          week: textOf(q('h3', section)),
          cards: [...section.querySelectorAll('.learn-assessment-card')].map(card => {
            const link = q('a[data-assessment-href], a[href*="quiz?id="], a[href*="quiz"]', card);
            const href = link ? (link.getAttribute('href') || '') : '';
            const idMatch = href.match(/[?&#]id=(\\d+)/);
            return {
              title: textOf(q('.learn-assessment-title', card)),
              deadline: textOf(q('.learn-assessment-deadline', card)).replace(/^截止时间[:：]\\s*/, ''),
              href,
              quizId: idMatch ? idMatch[1] : '',
              detail: textOf(card).slice(0, 200),
            };
          }).filter(card => card.title),
        })).filter(section => section.cards.length);
      `)
      for (const section of sections) {
        const week = norm(section.week)
        let target = week
          ? chapters.find(chapter => chapter.title.includes(week) || week.includes(chapter.title))
          : null
        if (!target) {
          target = { id: `assess-${week || 'quiz'}`, index: chapters.length + 1, title: week ? `测验与作业 · ${week}` : '测验与作业', units: [] }
          chapters.push(target)
        }
        for (const card of section.cards) {
          const kind = classifyText(card.title)
          target.units.push({
            id: `quiz-${card.quizId || card.title}`,
            title: card.title,
            kind: kind === 'exam' ? 'exam' : kind === 'homework' ? 'homework' : 'quiz',
            url: absoluteUrl(card.href),
            duration: '',
            deadline: card.deadline,
            status: '',
            score: '',
            site: 'new',
          })
        }
      }
    }
  } catch { /* 没有测验的课程很常见 */ }

  // ---- 考试 ----
  try {
    await page.goto(`${BASE}/mooc/learn/${shortName}/exams?tid=${termId}`, { waitMs: 4_000 })
    await activate(page)
    if (await waitSelector(page, '.learn-exam-card:not([data-skeleton-row])', 30_000)) {
      const exams = await run(page, `
        return [...document.querySelectorAll('.learn-exam-card')].map(card => {
          const link = q('a[href*="examObject"], a[href*="exam"]', card);
          const summary = textOf(q('.learn-exam-card-summary', card));
          const deadlineMatch = summary.match(/截止时间[:：]\\s*([^·]+)/);
          return {
            title: textOf(q('strong', card)) || textOf(q('.learn-exam-card-title', card)),
            summary,
            href: link ? (link.getAttribute('href') || '') : '',
            eid: String(card.getAttribute('data-legacy-exam-card') || ''),
            deadline: deadlineMatch ? norm(deadlineMatch[1]) : '',
          };
        }).filter(exam => exam.title);
      `)
      if (exams.length) {
        let target = chapters.find(chapter => chapter.title === '考试')
        if (!target) {
          target = { id: 'exams', index: chapters.length + 1, title: '考试', units: [] }
          chapters.push(target)
        }
        exams.forEach((exam, index) => {
          target.units.push({
            id: `exam-${exam.eid || index + 1}`,
            title: exam.title,
            kind: 'exam',
            url: absoluteUrl(exam.href),
            duration: '',
            deadline: exam.deadline,
            status: '',
            score: '',
            site: 'new',
          })
        })
      }
    }
  } catch { /* 没有考试的课程很常见 */ }

  return {
    courseId: course?.id,
    fetchedAt: new Date().toISOString(),
    source: 'dom',
    chapters,
  }
}

/** 老版 SPA（SPOC）：课件目录 + 测验与作业 + 考试（DOM 兜底）。 */
async function readLegacyOutlineDom(page, course) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  if (!shortName) throw await failWith(page, '这门课缺少课程标识，没法读取章节大纲。')
  const base = `${BASE}/spoc/learn/${shortName}?tid=${termId}`
  const contentUrl = String(course?.url || '').includes('#/learn/content')
    ? course.url
    : `${base}#/learn/content`

  await activate(page)
  await page.goto(contentUrl, { waitMs: 4_000 })
  await activate(page)
  await sleep(1_500)
  if (!(await waitSelector(page, '.m-learnChapterNormal', 30_000))) {
    throw await failWith(page, '没读到课件目录（.m-learnChapterNormal）：可能课程还没发布内容，或者需要在这个浏览器窗口里重新登录。')
  }

  const rawChapters = await run(page, `
    return [...document.querySelectorAll('.m-learnChapterNormal')].map((chapter, index) => {
      const title = textOf(q('.j-titleName', chapter)) || textOf(q('h3', chapter)) || ('第' + (index + 1) + '周');
      const units = [];
      for (const lesson of qa('.lessonBox .u-learnLesson, .u-learnLesson', chapter)) {
        const lessonTitle = textOf(q('.j-name', lesson));
        for (const item of qa('.sourceList .lsicon[data-cid]', lesson)) {
          const tag = textOf(q('.tag', item));
          const rawTitle = item.getAttribute('title') || textOf(item) || lessonTitle;
          const cleanTitle = norm(rawTitle).replace(/^(视频|讨论|文档|测验|作业|考试)\\s*/, '') || lessonTitle || tag;
          units.push({
            id: String(item.getAttribute('data-cid') || ''),
            title: cleanTitle.slice(0, 200),
            tag,
            lessonTitle,
            learned: /learned/.test(String(item.className)),
          });
        }
      }
      return { id: 'spoc-chapter-' + (index + 1), index: index + 1, title, units };
    });
  `)

  const chapters = rawChapters.map(chapter => ({
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    units: chapter.units.map(unit => ({
      id: unit.id || `${chapter.id}-${chapter.units.indexOf(unit) + 1}`,
      title: unit.title,
      kind: classifyText(`${unit.tag} ${unit.title}`),
      url: '',
      clickSelector: unit.id ? `.lsicon[data-cid="${unit.id}"]` : '',
      duration: '',
      deadline: '',
      status: unit.learned ? '已完成' : '',
      score: '',
      site: 'legacy',
    })),
  }))
  applyLegacyDiscussionFlags(chapters, rawChapters)

  // ---- 测验与作业 ----
  try {
    await page.goto(`${base}#/learn/testlist`, { waitMs: 4_000 })
    await activate(page)
    if (await waitSelector(page, '.u-quizHwListItem', 25_000)) {
      const items = await run(page, `
        const nodes = [...document.querySelectorAll('.m-learnChapterNormal, .u-quizHwListItem')];
        let week = '';
        const result = [];
        for (const node of nodes) {
          if (node.classList.contains('m-learnChapterNormal')) {
            week = textOf(q('.j-titleName', node)) || textOf(node);
            continue;
          }
          const title = textOf(q('.j-name', node));
          if (!title) continue;
          result.push({
            title,
            week,
            deadline: textOf(q('.j-submitTime', node)).replace(/^截止时间[:：]\\s*/, ''),
            score: textOf(q('.j-validScore', node)),
            hasButton: Boolean(q('.j-quizBtn, a, button', node)),
          });
        }
        return result;
      `)
      for (const item of items) {
        const week = norm(item.week)
        let target = week ? chapters.find(chapter => chapter.title.includes(week) || week.includes(chapter.title)) : null
        if (!target) {
          target = { id: `assess-${week || 'quiz'}`, index: chapters.length + 1, title: week ? `测验与作业 · ${week}` : '测验与作业', units: [] }
          chapters.push(target)
        }
        const kind = classifyText(item.title)
        target.units.push({
          id: `quiz-${norm(item.title)}`,
          title: item.title,
          kind: kind === 'exam' ? 'exam' : kind === 'homework' ? 'homework' : 'quiz',
          url: '',
          clickSelector: '',
          clickText: item.title,
          // 老 SPA 的测试项要点「前往测验」按钮，而不是只点标题
          clickScript: `const wanted = ${JSON.stringify(item.title)};
            const row = [...document.querySelectorAll('.u-quizHwListItem')].find(el => {
              const name = el.querySelector('.j-name');
              return name && (name.textContent || '').trim() === wanted;
            });
            if (!row) return false;
            const button = row.querySelector('.j-quizBtn, a.j-quizBtn, a, button');
            if (button) { button.click(); return true; }
            const head = row.querySelector('.j-titleBox');
            if (head) { head.click(); return true; }
            return false;`,
          duration: '',
          deadline: item.deadline,
          status: /得分/.test(item.score) ? `已作答（${norm(item.score)}）` : '',
          score: norm(item.score),
          site: 'legacy',
        })
      }
    }
  } catch { /* ignore */ }

  // ---- 考试 ----
  try {
    await page.goto(`${base}#/learn/examlist`, { waitMs: 4_000 })
    await activate(page)
    if (await waitSelector(page, '.u-quizHwListItem.eaxmListItem', 25_000)) {
      const exams = await run(page, `
        return [...document.querySelectorAll('.u-quizHwListItem.eaxmListItem')].map((item, index) => ({
          id: item.id || ('exam-' + (index + 1)),
          title: textOf(q('.j-name', item)) || ('考试 ' + (index + 1)),
          total: textOf(q('.j-totalScore', item)),
          detail: textOf(q('.j-detail', item)).slice(0, 400),
          status: textOf(q('.j-validScore', item)),
        }));
      `)
      if (exams.length) {
        let target = chapters.find(chapter => chapter.title === '考试')
        if (!target) {
          target = { id: 'exams', index: chapters.length + 1, title: '考试', units: [] }
          chapters.push(target)
        }
        for (const exam of exams) {
          const deadlineMatch = exam.detail.match(/(?:截止|提交截止)时间[:：]\s*([0-9/\- :]+)/)
          target.units.push({
            id: `exam-${exam.id}`,
            title: exam.title,
            kind: 'exam',
            url: '',
            clickSelector: `[id="${exam.id}"]`,
            clickText: exam.title,
            duration: '',
            deadline: deadlineMatch ? norm(deadlineMatch[1]) : '',
            status: '',
            score: exam.status,
            site: 'legacy',
          })
        }
      }
    }
  } catch { /* ignore */ }

  return {
    courseId: course?.id,
    fetchedAt: new Date().toISOString(),
    source: 'dom',
    chapters,
  }
}

// ---------------------------------------------------------------------------
// 新版视频
// ---------------------------------------------------------------------------

export async function playVideoUnit(page, unit, opts = {}) {
  const speed = Math.min(4, Math.max(0.5, Number(opts.speed) > 0 ? Number(opts.speed) : 2))
  const muted = opts.muted === true
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : () => {}
  const signal = opts.signal
  const title = norm(unit?.title) || '视频课时'
  const url = absoluteUrl(unit?.url)
  if (!url) throw await failWith(page, '这个视频单元没有可打开的地址')

  onTick({ percent: 1, message: '正在打开视频…', watchedSeconds: 0, durationSeconds: 0 })
  await activate(page)
  await page.goto(url, { waitMs: 5_000 })
  await activate(page)
  if (!(await waitSelector(page, 'video', 30_000))) {
    throw await failWith(page, `打开「${title}」后没有找到 <video>：可能这节课不是视频，或者播放器结构变了。`)
  }
  await sleep(1_000)
  let durationSeconds = await page.eval(`(() => { const video = document.querySelector('video'); return video && Number.isFinite(video.duration) ? video.duration : 0 })()`).catch(() => 0)
  if (!durationSeconds) {
    await sleep(2_500)
    durationSeconds = await page.eval(`(() => { const video = document.querySelector('video'); return video && Number.isFinite(video.duration) ? video.duration : 0 })()`).catch(() => 0)
  }

  await page.eval(`(() => {
    const video = document.querySelector('video');
    if (!video) return false;
    try { video.muted = ${muted ? 'true' : 'false'}; } catch (error) {}
    try { video.playbackRate = ${speed}; } catch (error) {}
    try { const promise = video.play(); if (promise && promise.catch) promise.catch(() => {}); } catch (error) {}
    return true;
  })()`).catch(() => false)

  const startedAt = Date.now()
  const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : 5 * 60 * 60 * 1_000
  let deadline = Math.min(startedAt + maxWaitMs, durationSeconds > 0 ? startedAt + (durationSeconds / speed) * 1_000 + 180_000 : startedAt + maxWaitMs)
  let watchedSeconds = 0
  let bestPercent = 0
  let completed = false
  let stalled = 0
  let lastCurrent = -1

  while (true) {
    if (signal?.aborted) {
      return { completed: false, watchedSeconds, durationSeconds, transcript: '', message: '已取消播放' }
    }
    if (Date.now() > deadline) break
    const status = await page.eval(`(() => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      try { if (video.paused && !video.ended) { const promise = video.play(); if (promise && promise.catch) promise.catch(() => {}); } } catch (error) {}
      return {
        found: true,
        current: Number(video.currentTime) || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        ended: Boolean(video.ended),
        paused: Boolean(video.paused),
        rate: Number(video.playbackRate) || 1,
      };
    })()`).catch(() => ({ found: false }))

    if (!status?.found) {
      await sleep(800)
      continue
    }
    watchedSeconds = status.current
    if (status.duration > 0) durationSeconds = status.duration
    if (durationSeconds > 0) {
      const percentValue = Math.min(99, Math.round((watchedSeconds / durationSeconds) * 100))
      if (percentValue > bestPercent) bestPercent = percentValue
      // 按剩余时长 × 倍速放宽截止时间（留 3 分钟缓冲）
      const remainMs = ((durationSeconds - watchedSeconds) / speed) * 1_000 + 180_000
      const limit = startedAt + remainMs
      if (limit < deadline) deadline = limit
    }
    const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    const message = durationSeconds > 0
      ? `正在播放：${bestPercent}%（${clock(watchedSeconds)} / ${clock(durationSeconds)}）${status.paused ? ' · 缓冲中' : ''}`
      : '正在播放视频…'
    onTick({ percent: bestPercent, message, watchedSeconds, durationSeconds })

    if (status.ended || (durationSeconds > 0 && watchedSeconds >= durationSeconds - 1.5) || bestPercent >= 99) {
      completed = true
      onTick({ percent: 100, message: '这一节视频看完了', watchedSeconds, durationSeconds })
      break
    }
    // 卡住不动超过 20 秒就尝试重新播放；60 秒仍卡住就退出
    if (Math.abs(watchedSeconds - lastCurrent) < 0.3) stalled += 1
    else stalled = 0
    lastCurrent = watchedSeconds
    if (stalled > 0 && stalled % 25 === 0) {
      await page.eval(`(() => { const video = document.querySelector('video'); if (video) { try { video.playbackRate = ${speed}; const promise = video.play(); if (promise && promise.catch) promise.catch(() => {}); } catch (error) {} } return true })()`).catch(() => {})
    }
    if (stalled > 75) break
    await sleep(1_200)
  }

  const transcript = await readVideoMaterial(page, title).catch(() => '')
  return {
    completed: completed || bestPercent >= 99,
    watchedSeconds,
    durationSeconds,
    transcript,
    message: completed || bestPercent >= 99
      ? `「${title}」播放完成${transcript ? '，已读到字幕/课堂要点' : ''}`
      : `「${title}」播到 ${bestPercent}% 就停了，可以重试这一节`,
  }
}

/** 尽量从新播放器里读字幕 / 智能总结，给答题和讨论当上下文。 */
async function readVideoMaterial(page, title) {
  // 1) 试着点开「查看字幕 / 字幕」
  for (const label of ['查看字幕', '字幕']) {
    try {
      const clicked = await page.clickText(label, { timeoutMs: 1_500 })
      if (clicked) { await sleep(1_500); break }
    } catch { /* ignore */ }
  }
  const material = await run(page, `
    const candidates = qa('[class*=subtitle],[class*=Subtitle],[class*=caption],[class*=transcript],[class*=Transcript],[class*=summary],[class*=Summary]').filter(isVisible);
    const chunks = candidates.map(textOf).filter(text => text.length > 40);
    // 「智能总结」区域
    const summaryNode = qa('div,section,article').filter(isVisible).find(el => /智能总结/.test(textOf(el)) && textOf(el).length < 6000);
    const summaryText = summaryNode ? textOf(summaryNode) : '';
    // 播放器里的章节分段（00:00–10:00 标题）
    const segments = qa('div,span,li').filter(isVisible).map(textOf).filter(text => /^\\d{1,3}:\\d{2}\\s*[–-]\\s*\\d{1,3}:\\d{2}/.test(text));
    const best = chunks.sort((a, b) => b.length - a.length)[0] || summaryText;
    return { best: best || '', summary: summaryText.slice(0, 4000), segments: segments.slice(0, 40) };
  `)
  const parts = []
  if (material?.summary) parts.push(material.summary.replace(/^智能总结\s*/, ''))
  if (material?.segments?.length) parts.push(material.segments.join('；'))
  const text = parts.join('\n').trim() || String(material?.best || '').trim()
  return text.slice(0, 20_000)
}

// ---------------------------------------------------------------------------
// 新版讨论区
// ---------------------------------------------------------------------------

export async function openForum(page, course) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  if (!shortName) throw await failWith(page, '这门课缺少课程标识，打不开讨论区。')
  await activate(page)
  await page.goto(`${BASE}/mooc/learn/${shortName}/forum?tid=${termId}`, { waitMs: 5_000 })
  await activate(page)
  if (!(await waitSelector(page, '.forum-create-topic', 25_000))) {
    throw await failWith(page, '没找到新版讨论区的「发起主题」入口：可能课程没开讨论区，或者页面结构变了。')
  }
  // 切到综合讨论区
  try {
    await run(page, `
      const target = qa('button,a,span,li,div').filter(isVisible).find(el => textOf(el) === '综合讨论区' && el.children.length <= 2);
      if (target) clickEl(target);
      return Boolean(target);
    `)
    await sleep(1_200)
  } catch { /* 默认板也能发 */ }
}

export async function postDiscussion(page, course, post = {}) {
  const shortName = shortNameOf(course)
  const termId = termIdOf(course)
  const title = norm(post?.title).slice(0, 40)
  const content = String(post?.content ?? '').trim()
  if (!title) throw new Error('发帖失败：标题是空的')
  if (!content) throw new Error('发帖失败：正文是空的')
  await activate(page)
  await page.goto(`${BASE}/mooc/learn/${shortName}/forum/topic?tid=${termId}`, { waitMs: 5_000 })
  await activate(page)
  if (!(await waitSelector(page, '.ql-editor, input[placeholder="请输入标题"]', 25_000))) {
    throw await failWith(page, '打开发帖页后没找到标题/正文编辑框。')
  }
  // 选版块：综合讨论区
  try {
    await run(page, `
      const target = qa('label,button,span,div,li').filter(isVisible)
        .find(el => textOf(el) === '综合讨论区' && el.querySelectorAll('*').length <= 3);
      if (target) clickEl(target);
      return Boolean(target);
    `)
    await sleep(800)
  } catch { /* 默认板也能发 */ }

  const filled = await run(page, `
    const titleInput = qa('input[placeholder="请输入标题"], input[type=text]').filter(isVisible)[0];
    if (!titleInput) return { ok: false, reason: 'no-title' };
    setInputValue(titleInput, ${JSON.stringify(title)});
    const editor = qa('.ql-editor[contenteditable=true], [contenteditable=true]').filter(isVisible)[0];
    if (!editor) return { ok: false, reason: 'no-editor' };
    editor.focus();
    const text = ${JSON.stringify(content)};
    let wrote = false;
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      wrote = /[\\u4e00-\\u9fa5]/.test(editor.innerText || '');
    } catch (error) { wrote = false; }
    if (!wrote) {
      editor.innerHTML = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      wrote = true;
    }
    return { ok: true, hasTitle: true, text: (editor.innerText || '').slice(0, 120) };
  `)
  if (!filled?.ok) throw await failWith(page, `发帖页没有写进去：${filled?.reason || '未知原因'}`)
  await sleep(600)

  const clicked = await run(page, `
    const target = qa('button,a').filter(isVisible).find(el => /发布主题|发布/.test(textOf(el)) && textOf(el).length <= 8);
    if (target) { clickEl(target); return true; }
    return false;
  `)
  if (!clicked) throw await failWith(page, '没有找到「发布主题」按钮。')
  await sleep(3_500)

  const state = await run(page, `
    return { url: location.href, text: (document.body.innerText || '').slice(0, 4000) };
  `)
  const success = /发表成功|发布成功|已发布|主题发布成功/.test(state.text)
    || (state.url.includes('/forum/') && !state.url.includes('/forum/topic'))
    || state.text.includes(title)
  return {
    ok: Boolean(success),
    url: state.url,
    message: success ? `已在综合讨论区发布：${title}` : '点了发布，但页面没有明确成功提示，请到讨论区确认一下',
  }
}

export async function readForumContext(page) {
  try {
    const text = await page.text()
    return { recentTitles: [], pageText: text.slice(0, 4000) }
  } catch {
    return { recentTitles: [], pageText: '' }
  }
}

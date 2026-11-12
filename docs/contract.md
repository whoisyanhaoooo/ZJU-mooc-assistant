# ZJU-mooc-assistant 接口契约（所有模块必须遵守）

> 这是一份**硬契约**。所有模块按这里定义的函数名、参数、返回结构实现；改动接口必须先告诉 Lead。
> 插件目标：左侧栏入口 → 打开 https://www.icourse163.org/category/all → 账号密码登录 → 读取「我的课程 / SPOC 课程」→
> 按章节列出 视频课/测验/作业/考试/讨论 任务 → 用户挑选任务 → 执行时实时进度条 → LLM 答题（测验两次机会，第二次必须满分）→
> 每上完一节课在综合讨论区参与讨论：优先针对老师在这节课提出的问题（字幕/思考题/讨论区置顶题），中立、只提问讨论，不表达情绪。

## 0. 运行环境与约定

- 插件根目录：`<插件目录>`（package name `ZJU-mooc-assistant`，APP_ID `ZJU-mooc-assistant`，侧栏名「ZJU-mooc-assistant」）。
- Node.js `v26`；**不允许新增任何 npm 依赖**，只用 Node 内置模块 + 全局 `fetch`/`WebSocket`。
- 所有 host 文件是 ESM `.mjs`；`client.js` 是浏览器端模块（`window.__ModuleLoader__.load({...})`，React 用 `require('react')`）。
- 代码注释、UI 文案、错误信息用简体中文。错误统一 `throw new Error('中文原因')`，不要抛裸字符串。
- 参考实现（同一工作区，已装好的插件，**照着它的风格写**）：
  - `..\dsh-zju-replay-notes\host\service.mjs`、`host\model.mjs`、`host\util.mjs`、`index.js`
  - `..\dsh-zju-replay-notes\client.js`（UI/CSS 审美基准，见第 6 节）
  - `..\cdp.mjs`（浏览器 CDP 的最小原型，可参考；生产代码要更完整）
- 数据目录：`$DSH_HOME/ZJU-mooc-assistant/`（`$DSH_HOME` 缺省 `~/.dsh`）。浏览器用户数据目录 `$DSH_HOME/ZJU-mooc-assistant/browser-profile`（持久化 Cookie，下次免登录）。
- **密码安全**：`account.json`（0600）保存账号；密码只在 `remember=true` 时保存。任何 API 返回、日志、错误信息里都**不允许**出现密码原文。

## 1. 文件与归属（谁写哪个文件，别越界）

| 文件 | 归属 |
| --- | --- |
| `package.json` `cordis.patch.yml` `index.js` `host/util.mjs` `host/service.mjs` `host/exec.mjs` `docs/contract.md` | Lead |
| `host/cdp.mjs` `scripts/probe.mjs` | browser-cdp 队友 |
| `host/mooc.mjs` `docs/icourse163.md` | mooc-adapters 队友 |
| `host/brain.mjs` `host/model.mjs` | llm-brain 队友 |
| `client.js` `icon.svg` `locale/zh.json` `locale/en.json` `README.md` | ui 队友 |

## 2. 宿主 API（client ↔ service）

- `POST /api/mooc-companion`，body `{ action: string, input?: object }`，响应 `{ value: any }` 或 `{ error: string }`（HTTP 4xx/5xx 同时带 error）。
- 前端调用方式与参考插件相同：

```js
function api(action, input = {}) {
  return fetch('/api/mooc-companion', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, input }),
  }).then(async r => { const b = await r.json().catch(() => null); if (!r.ok || b?.error) throw new Error(b?.error || '请求没有完成'); return b.value })
}
```

### 2.1 动作清单

| action | input | value |
| --- | --- | --- |
| `bootstrap` | — | `Snapshot`（见 2.2） |
| `status` | — | `Snapshot`（轮询用，轻量字段齐全） |
| `saveAccount` | `{email, password?, remember?}` | `{account: AccountView}` |
| `login` | `{force?:boolean}` | `{login: LoginState}`（立即返回，后台继续等验证码/跳转，之后轮询 status） |
| `logout` | — | `{login: LoginState}` |
| `openBrowser` | `{url?}` | `{browser: BrowserState}`（默认打开 `https://www.icourse163.org/category/all`） |
| `openPage` | `{url}` | `{browser: BrowserState, login?: LoginState}` |
| `openTaskPage` | `{taskId}` | `{browser: BrowserState, login?: LoginState}`（切到可见窗口并打开任务页） |
| `refreshCourses` | `{onlySpoc?:boolean}` | `{job: JobView}`（后台任务，轮询 status） |
| `selectCourse` | `{courseId}` | `{selectedCourseId, outline?: Outline}` |
| `refreshOutline` | `{courseId?}` | `{job: JobView}` |
| `runTask` | `{taskId}` | `{job: JobView}` |
| `cancelTask` | `{taskId}` | `{job: JobView}` |
| `planTask` | `{taskId, plannedAt: string\|null}` | `{task: TaskView}`（旧的单任务计划时间；`null` 取消计划） |
| `scheduleDeadline` | `{taskId, deadline: string}` | `{count, deadline, planned:[{id,title,plannedAt}]}`（设置计划截止时间：该任务及之前未完成的任务按顺序排随机完成时间，落在每天 8:00–24:00，到点自动执行） |
| `setSetting` | `{key, value}` | `{settings}` |
| `saveSettings` | `{settings}` | `{settings}` |
| `diagnostics` | `{dumpPage?:boolean}` | `{checks:[{name,ok,detail}], dumpPath?, browser, login}` |
| `clearLog` | — | `{ok:true}` |

### 2.2 数据结构（前端可直接渲染）

```ts
type Snapshot = {
  now: string,                    // ISO
  pluginVersion: string,          // 例如 0.2.0-portable
  settings: Settings,
  environment: EnvironmentCheck,   // 启动/设置变更后的环境自检
  account: AccountView,           // {email:string, hasPassword:boolean, remember:boolean, savedAt:string|null}
  browser: BrowserState,          // {running:boolean, port:number, url:string, title:string, startedAt:string|null}
  login: LoginState,              // {status:'unknown'|'pending'|'logged-in'|'failed', needUser:null|'captcha'|'verify'|'password'|'scan', message:string, user:{name?:string,email?:string}|null, at:string|null}
  courses: CourseView[],
  selectedCourseId: string|null,
  outline: Outline|null,          // 当前选中课程的章节树
  tasks: TaskView[],              // 当前选中课程的任务（按章节顺序）
  jobs: JobView[],                // 最近任务执行记录（新在前，最多 40）
  summary: {                      // 顶部统计卡
    chapterCount:number, taskCount:number, doneCount:number, videoDone:number, videoTotal:number,
    quizDone:number, quizTotal:number, examDone:number, examTotal:number, discussionDone:number, discussionTotal:number,
    averageScore:number|null, pendingCount:number
  },
  log: {at:string, level:'info'|'warn'|'error', text:string}[],   // 插件日志，最多 200 条，新在后
}

type EnvironmentCheck = {
  status: 'checking' | 'ready',
  ok: boolean | null,
  checks: { key: 'data'|'browser'|'model'|'port', ok: boolean, message: string }[],
  checkedAt: string | null,
}

type Settings = {
  nickname: string,                // 称呼，默认空（副标题不带名字）
  videoSpeed: number,              // 1–4，默认 2（认真看完，不跳着拖）
  videoMuted: boolean,             // 默认 false（真听，别静音）；用户可关
  autoDiscussAfterVideo: boolean,  // 上完一节课自动去综合讨论区提问，默认 true
  quizRepairSecondAttempt: boolean,// 第一次没满分就反思后重做第二次，默认 true（第二次必须满分）
  examAttempts: number,            // 考试最多尝试次数，默认 1（考试一般只允许一次）
  quizFillStrategy: string,        // 'model' | 'model+knowledge'，默认 'model+knowledge'
  reasoningEffort: string,         // '' | 'low' | 'medium' | 'high' | 'max'，默认 'medium'
  browserPort: number,             // 默认 9233
  browserPath: string,             // 留空自动找 Edge/Chrome
  maxJobs: number,                 // 默认 40
  autoRefreshCourses: boolean,     // 默认 false；打开浏览器/登录成功后自动刷新课程
  backgroundExecution: boolean,    // 默认 true；已登录且后台执行时用无头浏览器
}

type CourseView = {
  id: string, title: string, teacher: string, term: string, cover: string, url: string,
  spoc: boolean,                // 是否 SPOC 课程（页面「SPOC课程」tab 里的课程必须 true）
  state: string,                // 自由文本：进行中/已完结/…
  progress: number|null,        // 0–1
  school: string,
}

type Outline = {
  courseId: string, fetchedAt: string, source: 'dom'|'api'|'mixed',
  chapters: {
    id: string, index: number, title: string,
    units: UnitView[],
  }[]
}

type UnitView = {
  id: string, title: string, kind: 'video'|'doc'|'quiz'|'homework'|'exam'|'discussion'|'other',
  url: string,                 // 能直接打开的地址，可为空
  duration: string,            // 文本，可为空
  deadline: string,            // 文本，可为空
  status: string,              // 文本：未开始/已完成/…，可为空
  score: string,               // 文本，可为空
}

type TaskView = {
  id: string, courseId: string, courseTitle: string,
  chapterId: string, chapterIndex: number, chapterTitle: string,
  unitId: string, title: string,
  kind: 'video'|'quiz'|'homework'|'exam'|'discussion',
  status: 'idle'|'queued'|'running'|'done'|'failed'|'needs-user'|'skipped',
  plannedAt: string|null,     // 计划截止时间（自动排期生成的完成时间）；null 表示未排期
  autoRun: boolean,           // 是否到点自动执行（设置计划截止时间后为 true）
  attempts: number, score: number|null, maxScore: number|null,
  progress: { percent: number, phase: string, message: string, updatedAt: string|null },
  log: {at:string, text:string}[],   // 该任务执行日志，最多 60 条
  url: string,
  detail: string,              // 一句话说明（例如「第一次 60/100，重做第二次」）
  createdAt: string, updatedAt: string,
}

type JobView = {
  id: string, taskId: string|null, taskTitle: string,
  status: 'queued'|'running'|'done'|'failed'|'cancelled',
  percent: number, phase: string, message: string,
  startedAt: string, finishedAt: string|null, error: string|null,
}

type BrowserState = { running:boolean, port:number, url:string, title:string, startedAt:string|null }
type LoginState = {
  status:'unknown'|'pending'|'logged-in'|'failed',
  needUser:null|'captcha'|'verify'|'password'|'scan',
  message:string,
  user:{name?:string,email?:string}|null,
  at:string|null,
}
```

**任务 id 规则**：`${courseId}:${unitId}`，讨论任务 `${courseId}:${unitId}:discuss`（`unitId` 是所属视频单元 id）。同一课程重复刷新课程/大纲时，已有的任务保留 `status/score/plannedAt/progress/log`，只更新标题与章节信息。

**任务生成规则**（service 负责）：大纲里每个 `kind=video` 单元生成一个 `video` 任务；每个 `kind=quiz` 生成 `quiz`；`kind=homework` 生成 `homework`；`kind=exam` 生成 `exam`；每个 `video` 单元额外生成一个 `discussion` 任务（默认 `plannedAt` 跟随视频任务，`autoDiscussAfterVideo` 打开时视频完成后自动排入执行队列）。`doc/other` 不生成任务。

## 3. host/cdp.mjs（browser-cdp 队友实现）

```js
export class Browser {
  // opts: {port?:number, appId?:string, dataDir?:string, browserPath?:string, log?:(...a:any[])=>void}
  constructor(opts = {})
  get port(): number
  get started(): boolean
  async ensureStarted(): Promise<{port:number, reused:boolean, exe:string}>  // 已在跑就复用：先探 HTTP 127.0.0.1:port/json/version
  async listPages(): Promise<Array<{id:string, title:string, url:string, ws:string}>>
  async pageFor(urlPart = 'icourse163.org'): Promise<Page>  // 找到匹配页面复用；没有就新建一个 about:blank 再返回
  async newPage(url = 'about:blank'): Promise<Page>
  async open(url): Promise<Page>                            // 优先复用 icourse163 页面并 goto
  async bringToFront(): Promise<void>
  async stop(): Promise<void>                               // 关掉自己启动的浏览器（复用别人的实例时不动）
}

export class Page {
  async goto(url, opts?: {waitMs?:number, waitForExpr?:string, timeoutMs?:number}): Promise<void>
  async eval(expr, opts?: {awaitPromise?:boolean, timeoutMs?:number}): Promise<any>
  async waitFor(expr, opts?: {timeoutMs?:number, intervalMs?:number, label?:string}): Promise<boolean> // 超时 throw
  async waitForSelector(selector, opts?): Promise<boolean>
  async waitForUrl(fragment, opts?: {timeoutMs?:number}): Promise<boolean>
  async click(selector): Promise<void>                      // 找不到 / 不可见就 throw
  async clickText(text, opts?: {within?:string, timeoutMs?:number}): Promise<boolean> // 文本精确/包含匹配
  async type(selector, text): Promise<void>                 // 用原生 setter + input/change 事件，兼容 React
  async text(): Promise<string>                             // document.body.innerText
  async html(limit?:number): Promise<string>
  async url(): Promise<string>
  async title(): Promise<string>
  async screenshot(file): Promise<string>
  async cookies(domainPart?:string): Promise<Array<{name:string,value:string,domain:string}>>
  async cookieValue(name, domainPart?): Promise<string|null>
  async setUserAgent(ua): Promise<void>
  async close(): Promise<void>
  // 网络抓包（可选但强烈建议，mooc 提取器失败时用来 dump JSON 接口）：
  async startNetwork(): Promise<void>
  async takeNetwork(opts?: {filter?:string, since?:number}): Promise<Array<{url:string, status:number, type:string, body?:string}>>
  async stopNetwork(): Promise<void>
}
```

要求：
- 启动参数至少包含：`--remote-debugging-port=<port>`、`--user-data-dir=<dataDir>`、`--no-first-run`、`--no-default-browser-check`、`--disable-background-networking`、`--window-size=1280,900`，窗口要**可见**（验证码要用户手动滑）。`spawn(..., {detached:true, stdio:'ignore'}).unref()`。
- 浏览器查找顺序：`settings.browserPath` → Edge（`Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 等）→ Chrome → 报错「没找到 Edge 或 Chrome」。
- 启动后轮询 `http://127.0.0.1:<port>/json/version` 最多 20s；失败重试一次。
- WebSocket 用全局 `WebSocket`，每个命令 30s 超时；`Runtime.evaluate` 记得 `returnByValue: true`、`awaitPromise: true`、`userGesture: true`。
- 页面级事件：`Page.enable`/`Runtime.enable`；`Page.navigate` 后按 `waitMs`（默认 2500）等待，优先 `document.readyState === 'complete'`。
- 截图目录：`$DSH_HOME/ZJU-mooc-assistant/shots/`（用 util.ensureDir）。
- 提供 `scripts/probe.mjs` CLI：`node scripts/probe.mjs [url]` → 启动浏览器、打开页面、打印 title/url、截图到 `shots/probe.png`、列出页面里 `iframe` 数量、cookie 名。用于自测。

## 4. host/mooc.mjs（mooc-adapters 队友实现）

只关心 icourse163 站点行为；不碰 DSH API、不碰 LLM。所有函数第一参数是 `Page`（来自 cdp.mjs），出错时抛中文 Error，并把当前 `page.text()` 前 2000 字、url 附在 error 的 `.dump` 上（service 会写日志/快照）。

```js
export const URLS = { home, category, mycourse, spocTab?, login }
export function classifyKind(text, url): 'video'|'doc'|'quiz'|'homework'|'exam'|'discussion'|'other'

// 登录
export async function openLogin(page, {categoryFirst?:boolean}): Promise<void>  // 打开站点 + 登录入口（首页右上角「登录/注册」或 logon 页面）
export async function fillLogin(page, {email, password}): Promise<{mode:'page'|'popup'|'iframe', needSubmit:boolean}>
export async function submitLogin(page): Promise<void>
export async function checkLogin(page): Promise<{loggedIn:boolean, needUser:null|'captcha'|'verify'|'password'|'scan', message:string, user:{name?,email?}|null}>
export async function login(page, account: {email,password}, opts?: {timeoutMs?:number, onProgress?:(phase:string,msg:string)=>void}): Promise<{loggedIn:boolean, needUser, message, user}>
  // 填表 → 提交 → 轮询 checkLogin；出现滑块/验证码时**立即返回** needUser:'captcha' 并留用户手动完成（不要卡死）
export async function waitLogin(page, opts?): Promise<{loggedIn, needUser, message, user}>

// 课程
export async function readMyCourses(page, opts?: {onlySpoc?:boolean}): Promise<CourseView[]>  // 字段见 2.2
export async function readOutline(page, course: CourseView): Promise<Outline>

// 视频（认真上课）
export async function playVideoUnit(page, unit: UnitView, opts: {
  speed?:number, muted?:boolean, onTick?:(p:{percent:number, message:string, watchedSeconds:number, durationSeconds:number})=>void,
  signal?:AbortSignal, maxWaitMs?:number,
}): Promise<{completed:boolean, watchedSeconds:number, durationSeconds:number, transcript:string, message:string}>
  // 打开视频页 → 找到 <video> → 不静音（除非 muted）→ 2x 播放 → 定期报告进度 → 播完或进度 100% 完成
  // 有字幕轨/页面字幕文本就返回 transcript（给 brain 生成讨论问题与答题上下文），没有就返回已播完的章节标题描述

// 测验/作业/考试
export async function enterUnit(page, unit: UnitView): Promise<void>
export async function readQuestions(page, unit: UnitView): Promise<{
  questions: Array<{
    index:number, type:'single'|'multiple'|'judge'|'fill'|'short',
    stem:string, options: Array<{key:string, label:string}>,
    inputKind: 'radio'|'checkbox'|'text'|'textarea'|null,
  }>,
  submitLabel:string, pageTitle:string, rawText:string,
}>
export async function applyAnswers(page, answers: Array<{index:number, choice?:string|string[], text?:string}>): Promise<{applied:number, missing:number[]}>
export async function submitQuestions(page): Promise<{ok:boolean, message:string}>
export async function readQuizResult(page): Promise<{score:number|null, maxScore:number|null, fullMark:boolean, wrong:Array<{index:number,stem:string,chosen:string,correct:string}>, message:string, rawText:string}>
export async function beginAttempt(page): Promise<void>  // 有「开始答题」按钮就点

// 讨论区
export async function openForum(page, course: CourseView): Promise<void>          // 综合讨论区
export async function postDiscussion(page, course: CourseView, post: {title:string, content:string}): Promise<{ok:boolean, url:string, message:string}>
export async function readForumContext(page): Promise<{recentTitles:string[], pageText:string}>

// 自检
export async function selfCheck(page): Promise<Array<{name:string, ok:boolean, detail:string}>>
```

要求：
- 选择器**多套兜底**（类名前缀可能变：先 `[class*=...]` 模糊匹配，再文本匹配「章节/测验/作业/考试/讨论/提交/开始答题」），所有「定位不到」都要给出可操作的中文原因。
- 用 `page.eval` 注入的小工具函数自包含，避免每步重复代码；页面 DOM 取不到时可用 `page.startNetwork()` 抓 XHR/JSONP 兜底，把命中的 URL 写进 `docs/icourse163.md`。
- `docs/icourse163.md`：记录登录流程、实际选择器、频道 URL、SPOC 与非 SPOC 的差异、测验/考试/讨论区页面结构、抓到的接口、已知坑。每次自测更新。**这是给 Lead 和用户的证据，必须真实（可以写「未登录看不到，待验证」）**。

## 5. host/brain.mjs + host/model.mjs（llm-brain 队友实现）

```js
// model.mjs：照抄参考插件 ../dsh-zju-replay-notes/host/model.mjs 的 askModel，改成通用：
export async function askModel(ctx, {system, text, maxTokens?, reasoningEffort?, timeoutMs?, signal?}): Promise<string>
export async function askJson(ctx, opts, {schemaHint?, retries?}): Promise<any>
  // askJson：要求模型只输出 JSON，剥离 ```json 围栏，JSON.parse；失败按 retries 重试并提示错误

// brain.mjs（ctx 是 DSH ctx；用 askModel/askJson；不碰浏览器）
export async function answerQuizWithModel(ctx, {
  course: {title, teacher}, chapter: {title}, unit: {kind, title},
  questions: Array<{index,type,stem,options,inputKind}>,
  lesson: {summary?:string, transcript?:string} | null,
  attempt: number,                       // 1 或 2
  previous: null | {score:number, maxScore:number, wrong:Array<{index,stem,chosen,correct}>},
  settings: Settings,
}): Promise<{
  answers: Array<{index:number, choice?:string|string[], text?:string}>,
  confidence: number, reasoning: string,
  raw: string,
}>
  // 第一次：认真读题，能联系课上的内容就联系；第二次：把上次错的题重点反思，答案必须修正为满分
export async function writeDiscussionQuestion(ctx, {
  course: {title}, chapter: {title}, lesson: {title, summary?:string, transcript?:string}, forum?: {recentTitles?:string[], pageText?:string},
  kind: 'question', settings: Settings,
}): Promise<{title:string, content:string}>
  // 产出：标题 ≤ 30 字；正文 80–200 字；表述中立、精简但有深度，只提问讨论、不表达情绪；
  // 优先针对老师在这节课提出的问题（字幕/小结/讨论区置顶题）参与讨论；找不到才围绕本节核心问题提问，不要空话套话
export async function summarizeLesson(ctx, {title, transcript, kind, settings}): Promise<{summary:string, keyPoints:string[], confusion:string}>
```

要求：
- `answerQuizWithModel` 的 `answers` 必须和 `questions.index` 对齐；单选 `choice` 用选项 key（A/B/C/D 或选项文本 key，按 mooc 返回的 `options[].key`）；判断 `choice` 用 `'true'|'false'`（mooc 会映射）；多选 `choice` 是数组；填空 `text` 是字符串。
- 模型输出不可靠时，`askJson` 要重试 2 次并在 prompt 里给严格 JSON 模板；最终仍失败就抛错，绝不编造空答案。
- 系统提示中文、明确「你是正在上这门课的学生」。

## 6. client.js（ui 队友实现）

- 注册方式与参考插件**完全一致**（`window.__ModuleLoader__.load({id:'ZJU-mooc-assistant', factory(require){...}})`）：
  - `inject: ['slots']`
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'mooc-companion', order:34, label:'ZJU-mooc-assistant' }, PanelIcon))`
  - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'mooc-companion' }, Page))`
  - 注入 `<style data-plugin="ZJU-mooc-assistant">`，随 `ctx.effect` 清理
- 审美与排版**对齐**参考插件的 `client.js`：同样的 `@font-face` IBM Plex Sans（直接从参考文件复制那段 base64 `@font-face`）、同样的 CSS 变量（`--dsw-alias-*`）、卡片/统计/胶囊/进度条/折叠动画/骨架屏/容器查询/`prefers-reduced-motion`；类名前缀用 `mcn-`（避免与 `zrn-` 冲突）。
- 页面结构（参考插件的 head + stats + 双列 grid + cards）：
  1. **头部**：标题「ZJU-mooc-assistant」，副标题「<设置里的称呼>的中国大学 MOOC 上课助手」，没填称呼时是「中国大学 MOOC 上课助手」；按钮：`打开中国大学 MOOC`（openBrowser，默认 category/all）、`登录`/`检查登录`、`刷新`。
  2. **状态提示条**：未登录提醒、需要用户完成滑块验证的提醒（醒目）、浏览器未启动提醒、错误 alert。
  3. **统计卡 4 个**：课程数 / 已完成任务 / 视频进度 / 平均分（来自 `summary`）。
  4. **左列**：`章节任务` 卡片 —— 当前课程选择器 + 刷新大纲；章节折叠面板（每章标题带进度 x/y），章内任务行：类型胶囊（视频/测验/作业/考试/讨论）+ 标题 + 状态胶囊 + 计划截止时间 + `自动完成` 胶囊 + `开始`/`取消`/`重试` 按钮；行内显示任务进度条（status=running 时实时）。
  5. **右列**：`账号与登录` 卡片（邮箱/密码/记住密码，登录按钮，登录状态与用户信息，密码不回显）；`课程` 卡片（我的课程列表，SPOC 课程带「SPOC」胶囊，点选后加载大纲，显示封面/教师/学期/进度）；`执行进度` 卡片（正在执行的任务大进度条 + 阶段文字 + 最近日志，来自 `jobs`）；`设置` 卡片（视频倍速、静音、上完课自动提问、测验重做、考试次数、模型思考强度、浏览器端口、浏览器路径、每任务执行间隔等，仿参考插件的折叠设置）。
  6. **任务选择**：点「计划截止时间」打开自定义日历 + 时间滚轮（每天 8:00–24:00）；确定后调用 `scheduleDeadline`，该任务及之前未完成的任务按顺序自动完成；顶部提供筛选（全部/视频/测验/作业/考试/讨论/未完成）。
  7. 轮询：`status` 每 1500ms（页面可见时），`bootstrap` 首次加载；任务运行时进度条平滑动画；错误 toast。
- 交互细节：按钮 loading 态、禁用态、空态文案（「还没有课程，先登录再刷新」「选一门课程查看章节」）、`aria-live` 提示、键盘可用。
- 密码框 `type="password"`；保存后清空输入框；页面只显示「已保存密码」。
- `icon.svg`：24×24 语义的简洁图标（建议：播放/课程/学习感，线条 1.8，参考 `..\dsh-zju-replay-notes\icon.svg` 的构图与配色），供插件管理和侧栏用。
- `locale/zh.json` 与 `en.json`：`{"meta":{"title":"ZJU-mooc-assistant","description":"..."}}`。
- `README.md`：安装方式（local link）、功能、使用步骤（登录→刷新课程→选课→按章节挑任务→看进度）、注意事项（首次需在弹出窗口手动完成滑块；考试一般只有一次；讨论区发言需遵守课程规范）、文件结构、自检命令。
- 自测：`node --check client.js`；UI 无法在本机浏览器单独跑，但必须保证语法与 DSH slot 注册正确。

## 7. Lead 侧实现（service.mjs / exec.mjs）

- `exec.mjs`：`runTask(task)` 按 kind 分派，通过 `onProgress({percent, phase, message, logLine})` 回调上报；返回 `{ok, status, score, maxScore, detail, transcript?, discussion?}`。
  - video：打开单元 → 播放（speed/muted）→ onTick 更新百分比 → 完成后若 `autoDiscussAfterVideo` 则把 discussion 任务排进队列。
  - quiz/homework：enterUnit → beginAttempt → readQuestions → brain 作答 → applyAnswers → submitQuestions → readQuizResult；若未满分且 `quizRepairSecondAttempt` → 反思重做（attempt=2），直到满分或没有机会。
  - exam：同 quiz，但 `examAttempts` 次数控制。
  - discussion：打开综合讨论区 → 结合该视频任务的 transcript/summary → `writeDiscussionQuestion` → `postDiscussion` → 校验成功。
- `service.mjs`：状态持久化（`state.json`/`settings.json`/`account.json`）、串行任务队列（同时只跑一个网页任务，避免浏览器打架）、登录轮询、课程/大纲刷新、API 注册（`connection.fetch.register`，同参考插件）、日志与任务进度。
- `index.js`：`inject = ['connection']`；`ctx.effect` 生命周期，插件卸载时停浏览器与定时器。

## 8. 自测与验收（每个队友完成时在消息里报告）

1. `node --check <你的每个 js/mjs 文件>` 全绿。
2. 你的模块能单独 import（host 模块：`node -e "import('./host/xxx.mjs').then(m=>console.log(Object.keys(m)))"`）。
3. cdp 队友：`node scripts/probe.mjs` 能打开 icourse163 并截图（把截图路径写进消息）。
4. mooc 队友：用 probe 页面对**未登录公开页面**验证能读出课程分类/课程卡片结构；登录相关写进 docs 并标注待验证项。
5. brain 队友：写一个离线小脚本自测 `askJson`（可用 `node -e` 构造假 ctx，不联网也能测 JSON 解析分支）。
6. ui 队友：`node --check client.js`；把最终注册代码片段贴给 Lead 确认。
7. 报告格式：`完成：<文件清单>；接口偏差：<无/说明>；测试：<命令与结果>；风险/待验证：<列表>`。

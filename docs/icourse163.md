# icourse163 适配记录（ZJU-mooc-assistant）

> 这份文档记录 `host/mooc.mjs` 的调研依据。**已实测** = 本轮真实打开页面/接口验证过；
> **待验证** = 没有真实账号、登录后页面无法访问，只做了多套兜底实现，等有账号时再补。
>
> 验证环境：2026-11-10，Windows + Edge 157.0.4341.42，可控调试浏览器（端口 9233）。
> 前 1–7 节是未登录时的公开页调研；第 9 节是新版 MOOC 站在登录态（用户本人账号）下的实测补记。
> 验证工具：`scripts/mooc-inspect.mjs`、`scripts/probe.mjs`、CDP 直连。

## 0. 结论速览

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| 打开首页/分类页/课程详情页 | 已实测 | 分类页、`/course/ZJU-199001` 正常渲染 |
| 打开登录弹层 | 已实测 | 只有首页有 `window.eds.loginDialog` |
| 手机号/邮箱 iframe 内填账号密码 | 已实测（截图确认） | CDP frame 上下文写入 `#phoneipt` + password |
| 登录成功/滑块/短信验证判定 | 待验证 | 没有真实账号 |
| 我的课程 + SPOC 列表 | 已实测（2026-11-10 登录态） | RPC `learnerCourseRpcBean.getMyLearnedCoursePanelList`，courseType=1/2 |
| 学习页章节大纲 | 已实测（2026-11-10 登录态） | RPC `courseBean.getLastLearnedMocTermDto`（SPOC 用源课程 termId） |
| 章节大纲公开兜底 | 已实测 | 课程详情页 `.outlineBody` 解析出 8 章 |
| 视频播放/进度 | 已实测（2026-11-10） | 新版 `/mooc/learn/...` 与 SPOC 老播放器都能播、报进度、取消 |
| 测验/作业/考试读题、作答、提交、成绩 | 部分实测 | 能进测验介绍页并找到「开始测验」；作答/提交未实测（避免消耗用户的 2 次机会） |
| 综合讨论区发帖 | 部分实测 | 讨论区/发帖页可打开，标题 + Quill 正文能填；未真正点发布（避免往真实课程发测试帖） |

## 1. 登录（已实测）

### 1.1 入口

- 站点：`https://www.icourse163.org/`（首页）。
- 右上角登录入口是 **div 不是链接**：`.navLoginBtn`（文本「登录 | 注册」）。首页 hero 区还有一个
  `._3uWA6`（role=button，文本「登录/注册」），两者 `onClick` 都是
  `window.eds.loginDialog.showLogin()`。
- **坑（重要）**：`window.eds.loginDialog` 只在首页存在；在 `/category/all` 上实测
  `window.eds === undefined`，点 `.navLoginBtn` 没有任何反应。所以 `openLogin()` 会先回到首页再点。
- 不存在的登录页：`/logon.htm` GET 返回 405 Whitelabel Error Page；`/member/logon.htm`、`/login`
  都落到 `/error/commonError.htm#/error`。**不要自己拼登录页 URL**。
- 补充（2026-11-10 实测）：提交登录失败后，顶层页面会被导航到
  `/member/login.htm?emailEncoded=...&errorCode=-1#/webLoginIndex`，登录弹层仍然保留，
  弹层里出现「账号或密码错误」文字、3 个 passport iframe 还在。这个状态对 `checkLogin` 有用：
  它会返回 `needUser:'password'`（实测）。`openLogin` 看到当前地址不是首页时会先回首页。

### 1.2 登录弹层（主框架 DOM）

- 弹层：`.ux-modal_dialog`（可见）。
- tab：`.ux-tabs-underline li`，文本「手机号登录 / 邮箱登录 / 爱课程登录」，选中的 li 带 `z-sel`。
- 底部还有「校园用户登录」链接 `a.c-loginbtn`（跳学校云/统一认证，未展开）。
- 「爱课程登录」tab 是主框架里的普通表单：`.icourse-login-form`（带 `tab-hide` 类隐藏），
  账号/密码 `input[placeholder="  账号"] / [placeholder="  密码"]`，表单 POST 到
  `//www.icourse163.org/passport/reg/icourseLogin.do`。这是 iCourses 账号体系，和网易账号不同。

### 1.3 网易 passport iframe（已实测结构）

弹层里预加载 **3 个跨域 iframe**（`reg.icourse163.org`），URL 形如：

```
https://reg.icourse163.org/webzj/v1.0.1/pub/index_dl2_new.html?cd=...&product=imooc&...
https://reg.icourse163.org/webzj/v1.0.1/pub/index_dl2_new.html?...   （第二个实例 = 邮箱登录）
https://reg.icourse163.org/webzj/v1.0.1/pub/index_reg2_new.html?...  （注册）
```

| tab | 账号输入框 | 密码输入框 | 登录按钮 | 其他 |
| --- | --- | --- | --- | --- |
| 手机号登录 | `#phoneipt`（type=tel，placeholder「请输入手机号」，class `dlemail`） | 可见 `input[type=password]`（placeholder「请输入密码」，class `j-inputtext dlemail`） | `a.u-loginbtn`（文本「登 录」） | `a.tab1`「短信快捷登录」；`a.forgetpwdReg`「忘记密码？」 |
| 邮箱登录 | `input` placeholder「网易邮箱/常用邮箱」（class `j-inputtext dlemail`） | `.j-inputtext.dlpwd`（placeholder「密码」） | `a.u-loginbtn` | 验证码 `.j-inputtext.cktext`（默认隐藏）、`#un-login`「十天内免登录」 |

**哪个 iframe 是当前 tab**：三只 iframe 都在 DOM 里，非当前 tab 的 iframe 定位在 `x=-10000`
（实测三只 iframe 的 rect.x 分别是 -10000、100、-10000）。规则：`rect.width>0 && rect.height>0 && rect.x > -1000`
就是当前可见的那只。`fillLogin` 用这条规则选活动 iframe；切 tab 时点主框架的
「邮箱登录 / 手机号登录」li 再重新定位。

**跨域访问**：主页面 `iframe.contentDocument` 是 `null`（跨域），不能直接 `page.eval` 操作。
实现用 CDP 的：

1. `Page.getFrameTree` 拿到 frame id；
2. `Page.createIsolatedWorld({frameId})` 拿到 `executionContextId`；
3. `Runtime.evaluate({contextId, expression})` 在 iframe 的独立世界里操作 DOM。

隔离世界共享同一份 DOM，原生 setter + `input/change/keyup` 事件照样会触发 iframe 里页面的监听。
**已实测**：用这套方案 `#phoneipt` 与密码框都填进去了（截图确认，示例手机号 + 密码点）。

### 1.4 登录状态判定（已实测未登录基线）

- Cookie（CDP `Storage.getCookies` 能拿到 HttpOnly）：登录后应出现
  `STUDY_SESS / STUDY_INFO / STUDY_PERSIST / NTES_SESS / P_INFO / NTES_PASSPORT` 之一。
  **坑**：未登录也有 `NTESSTUDYSI`（就是页面 `csrfKey`），不能当登录依据。
- 用户接口：`GET /web/j/mocMemberFollowBean.userInfo.rpc?csrfKey=...`
  - 未登录实测返回 `{"code":0,"result":null,...}`；
  - 登录后预期返回带昵称的对象（**待验证**），`checkLogin` 会从里面取 `nickName/realName/email`。
- DOM：`.navLoginBtn` 是否可见、是否有「我的课程」入口、头像/昵称类元素（模糊匹配）。
- 未登录 `document.cookie` 基线里只有 `NTESSTUDYSI / EDUWEBDEVICE / Hm_lvt_* / HMACCOUNT / WM_NI`。

### 1.5 滑块 / 短信验证 / 扫码（待验证，检测策略已实现）

- 易盾滑块容器：`[class*=yidun]`、`.yidun_popup`、`#captcha`、`[class*=captcha]`、
  `[class*=slide-verify]`、`[class*=nc_iconfont]`，以及弹层内文案「拖动滑块 / 滑动验证 /
  请完成下方验证 / 拖动下方滑块 / 请完成安全验证」。
- 短信/邮箱验证：可见 `input[placeholder*=验证码]`，或文案「请输入短信验证码 / 短信验证码已发送」。
- 扫码：可见 `[class*=qrcode] / img[src*=qrcode]`（注意弹层里永远有「手机扫码，安全登录」文案，不能只看文字）。
- **坑（已修）**：一开始用页面级 `[class*=slider]` 和「安全验证」文案判定，结果未登录的首页/分类页
  误报 `needUser:'captcha'`（首页轮播常用 slider 类名）。现在 `checkLogin` 只在**登录弹层真的打开**
  （`.ux-modal_dialog` 或 passport iframe 存在）时才调用 `detectLoginIssue`，且只认真实可见的验证码容器；
  判断不了就返回 `needUser:null`。已验证：分类页/首页 `checkLogin` → `{loggedIn:false, needUser:null}`。
- `login()` 的设计：填表 → 提交 → 最多轮询 ~20s，一旦出现 captcha/verify/scan/password 立即返回，
  把控制权交还用户（用户手动完成后由 service 调 `checkLogin` / `waitLogin`）。

## 2. 我的课程（待验证）

- URL：`https://www.icourse163.org/home.htm`（个人中心）。
  - 未登录实测：跳 `/error/commonError.htm#/error`，页面文字「您访问的页面丢了,您无权访问此页面」。
  - SPOC tab 预期 `home.htm#/home/spoc`（**待验证**，实测未登录打不开）。
- 登录后真实 DOM **待验证**。实现策略（`readMyCourses`）：
  1. 先 `checkLogin`，未登录直接给中文错误；
  2. 依次尝试 `home.htm` → `#/home/course` → SPOC tab；遇到 `/error/` 换下一个；
  3. 抓 `a[href*="/learn/"]`（SPOC 是 `/spoc/learn/`），从链接向上最多 8 层找「像课程卡片」的容器；
  4. 字段从卡片里模糊取：`[class*=courseName|courseTitle|title|name]` 标题、
     `[class*=teacher|lector]` 老师、`[class*=term|semester]` 学期、`[class*=school]` 学校、
     `img` 封面、文本里的 `x%`/`n/m 节` 进度、`进行中|已结束|…` 状态；
  5. SPOC 判定：href 含 `/spoc/`、卡片文本含 `SPOC`，或从「SPOC课程」tab 抓到的都标 `spoc:true`；
  6. `onlySpoc:true` 时只返回 SPOC（先过滤，再点 SPOC tab 补抓一次）。
- 课程 id 从 href 里取 `(?:spoc/)?learn/{schoolShortName}-{courseId}`，例如 `ZJU-199001`；
  没有这个 pattern 时退回 `tid-{termId}`。
- 公开页面无法验证卡片解析，因为未登录看不到「我的课程」；但同一套 `collectCourses()` 逻辑
  在首页/搜索页能识别出 `a[href*=course]`（搜索页实测 607 个结果、课程卡片用 CSS Modules 哈希类名）。

## 3. 章节大纲

### 3.1 学习页 URL（已实测未登录行为）

- MOOC：`https://www.icourse163.org/learn/{schoolShortName}-{courseId}?tid={termId}`
  - 实测：`/learn/ZJU-199001?tid=1488058494` 未登录 302 到 `/course/ZJU-199001?tid=1488058494`。
- SPOC：`https://www.icourse163.org/spoc/learn/{schoolShortName}-{courseId}?tid=...`（**待验证**；
  实测未登录 `/spoc/learn/ZJU-199001` 跳首页）。
- 结论：未登录访问 learn URL 会跳走，**不能**据此判断「课程不存在」。

### 3.2 学习页左侧章节菜单（待验证）

登录后学习页（SPOC 可能不同）左侧是章节树。没有账号看不到真实 DOM，实现按「多套兜底」写：

1. 先找章节标题元素：可见元素文本匹配
   `^(第[一二三四五六七八九十百\d]+[章周讲单元]|Chapter\s*\d+|Unit\s*\d+|第\d+部分)`，
   长度 ≤ 80，去掉互相包含的重复项；
2. 每个标题往上找 5 层，找含单元节点的容器；
3. 单元节点：`a[href]`、`[class*=item|unit|lesson|section]` 去嵌套重复、去空文本；
4. 没有「第X章」标题时，按 `[class*=chapter|Chapter|catalogue|catalog|outline|menu|section]`
   容器分组（容器内要有 2~200 个单元节点）；
5. 单元类型：class / `data-type` / `data-kind` / href 里的 `type=` 参数 / 图标 class / 标题关键词，
   依次判 exam → quiz → homework → discussion → video → doc；
6. 时长 `1:23:45` 或「N 分钟」、截止「截止 …」或日期、状态「已完成/未开始/…」、成绩「N 分」从单元文本正则提取；
7. unit.url 用 `a.href`（绝对地址）；没有链接的单元 `enterUnit` 会按标题文本点击。

### 3.3 公开兜底：课程详情页「课程大纲」（已实测）

- 未选课时 `https://www.icourse163.org/course/ZJU-199001` 的「课程大纲」区域：
  `.outline` → `.outlineBody` → `.f-richEditorText`，**纯富文本，没有单元链接/状态**。
  段落 `<p><span style="font-size: 16px">第1周：程序设计与C语言</span></p>`（章标题）
  与 `<span style="font-size: 13px">1 计算机和编程语言</span>`（单元），
  以及 `<span>第1周编程练习</span>`（作业）。
- `readOutline` 学习页读不到时会退回这里，返回 `source: 'mixed'`：
  - 章标题 = 字号 ≥ 15px 或以「第X周/第X章」开头且不含「练习/作业/测验/考试/讨论」；
  - 「第X周编程练习」判为 `homework`，编号条目 `1 计算机和编程语言` 判为 `video`；
  - 单元没有 url/时长/状态/成绩（公开页不提供），`source` 标明 `mixed` 提醒用户。
- **2026-11-10 实测解析结果**：8 章（第1~8周），每周视频条目 + 编程练习，示例：
  ```
  第1章 第1周：程序设计与C语言
    - [video] 1 计算机和编程语言
    - [video] 2 C语言
    - [video] 3 第一个程序
    - [homework] 第1周编程练习
  ```

## 4. 视频页（待验证）

- 需要选课后的学习页内容区（SPOC 同）。实现：
  - 打开单元（`unit.url` 或按标题点击）；
  - 在主框架 + 所有 iframe 里找 `<video>`（视频可能在 iframe 播放器里）；
  - `video.playbackRate = speed`（默认 2）、`video.muted` 按设置、`play()`（带 catch 防自动播放拦截）；
  - 每 1.5s 读 `currentTime/duration/paused/ended`，回调 `onTick({percent, message, watchedSeconds, durationSeconds})`；
  - 暂停自动恢复；`ended` 或进度 ≥ 99% 视为完成；按剩余时长 × 倍速动态放宽超时；
  - 字幕：优先 `video.textTracks` 的 cues，其次页面 `[class*=subtitle|transcript|caption|zmu]` 文本，
    都拿不到返回空字符串（`transcript:''`）。
- 已知：icourse163 用网易自有播放器（页面加载 `VIDEOPLAYER`、`cryptoJS`、`videoAesUtils`），
  视频地址加密。**不要试图抓 mp4 地址**，只驱动 DOM `<video>`。

## 5. 测验 / 作业 / 考试页（待验证）

- 入口：学习页里的单元链接/标题；`enterUnit` 打开后 `beginAttempt` 点
  「开始答题 / 开始测验 / 开始考试 / 继续答题 / 进入答题 / 重新答题」，并处理「确定/确认/继续」二次弹窗，
  以及「我已阅读并同意」勾选框。
- 读题 `readQuestions`：在主框架 + 各 iframe 里比较题目数量，取题目最多的上下文。
  - 题目容器：`[class*=question-item|questionItem|u-question|m-question|j-question|question|subject-item|timu|ti-item]`，
    去掉包含其它候选的外层、按题干去重；
  - 退化：按 radio/checkbox 的 `name` 分组；再退化：每个 textarea/contenteditable 的最近容器；
  - 选项：含 input 的 `label`；否则 `[class*=option|choice|select-item|answer-item|item]` 中含 input
    或以 `A. / B、` 开头的元素；key 取 input.value 或文本前缀字母，label 去掉字母前缀；
  - 题型：文案「判断题/多选题/单选题/填空题/简答题」优先，否则按控件（checkbox→multiple、
    两个「正确/错误」选项→judge、无选项+textarea→short、无选项+text→fill）。
- 填答案 `applyAnswers`：
  - 单选/多选：按 option.key / input.value / label 匹配后 click 对应 input；
  - **判断题（llm-brain 硬要求）**：`choice` 为 `true/正确/对/是/√` → 选 label 含「正确/对/是」的选项；
    `false/错误/错/否/×` → 选 label 含「错误/错/否」的选项；给字母 A/B 时按 option key/value 匹配。
    多选 `choice` 支持数组逐个勾选；
  - 填空/简答：`text` 写入 input/textarea（原生 setter + input/change/KeyboardEvent）或
    contenteditable（`execCommand('insertText')` 兜底 + input 事件），React 受控组件也能收到。
- 提交 `submitQuestions`：找「提交/交卷/提交答案/保存并提交」，点击后处理 3 轮二次确认弹窗
  （先把页面 `window.confirm` 顶成 `() => true`，避免 CDP 卡在原生对话框），
  再按页面文字判断是否提交成功。
- 成绩 `readQuizResult`：解析「得分/成绩/分数：N」「N 分 / M 分」「满分/总分：M」，
  比较得满分；错题块里找「正确答案 / 我的答案」；页面上若有「查看成绩/查看解析」会先点开再读。

## 6. 综合讨论区（待验证）

- 入口在课程学习页里（文字「综合讨论区 / 讨论区 / 讨论」）；也尝试 hash 路由
  `#/learn/forum`、`#/learn/discuss`、`#/learn/community`、`#/forum`。
- `openForum(page, course)` 接收的 course 可能只有 `{id,title}`（exec 传的就是这样）：
  会依次用 `course.url` → 当前学习页 → 去「我的课程」按 id/title 找链接 → 拼 learn URL。
- 发帖 `postDiscussion`：点「发表话题/发帖/发布话题/发表新帖/写话题/发起话题/发表」，
  标题写 `input[placeholder*=标题]`，正文写可见 `contenteditable`（优先）或 `textarea`，
  点「发布/发表/提交」，处理确认框，最后校验页面出现「发表成功/发布成功」或标题文本。
- 讨论区结构（话题列表 class、发帖编辑器、是否要验证码）**待验证**。

## 7. 抓到的接口（未登录可抓）

| 接口 | 用途 | 实测 |
| --- | --- | --- |
| `GET /web/j/courseBean.getCoursePanelListByFrontCategory.rpc?csrfKey=...` | 分类页课程面板数据（`code:0`，result.result 里有课程/学期/教师列表） | 200 ✅ |
| `GET /web/j/courseBean.getMocTermStatisticListByParms.rpc?csrfKey=...` | 热门课程 + 参加人数 | 200 ✅ |
| `GET /web/j/courseBean.getSpecificByCategoryId.rpc?csrfKey=...` | 分类页广告/专题位 | 200 ✅ |
| `GET /web/j/mocCourseCategoryBean.getCategByType.rpc?csrfKey=...` | 分类树 | 200 ✅ |
| `GET /web/j/mocMemberFollowBean.userInfo.rpc?csrfKey=...` | 登录态用户信息（未登录 `result:null`） | 200 ✅ |
| `GET /web/j/indexBeanV3.*.rpc` / `recommendRPCBean.*` | 首页模块/推荐 | 200 ✅ |

- 页面脚本（首页/课程页可见）：`pt_web_course_intro`、`pt_web_course_info`、`core`、`VIDEOPLAYER`、
  `cryptoJS`、`videoAesUtils`、`bootstrap.js`（`mc.stu.126.net/rc/bootstraps/main/`）。
  React SPA 的 learn 组件 chunk（`LearnCourseMenu`、`LearnCourseVideo`、`NewExam`、`LearnCommunityTab`）
  在 `mc.stu.126.net/rc/main/assets/`，但 CDN 对直接下载返回 500，没继续深挖。
- 说明：分类页 `#j-courseCardListBox` 在本机环境下是 `display:none` 且显示「抱歉，暂无相关内容」，
  但 XHR 明确返回了课程数据（疑似本机渲染 bug/风控）。所以解析课程卡片没有依赖分类页 DOM。

## 8. 已知坑（写代码时都踩过）

1. **登录弹层只在首页**：分类页 `window.eds` 不存在，点登录按钮无效。
2. **passport iframe 跨域**：`contentDocument === null`，必须走 CDP frame 上下文。
3. **多 iframe 预加载**：隐藏的 iframe 定位在 `x=-10000`，按 rect 选可见的那个。
4. `/logon.htm` 不支持 GET（405），不要自己拼登录页地址。
5. `NTESSTUDYSI` 未登录也有，不能当登录 Cookie。
6. 首页轮播用 slider 类名，早期 captcha 检测会误报（已修：只在登录弹层打开时判定）。
7. 课程卡片大量使用 CSS Modules 哈希类名（如 `_3NYsM`），不要依赖固定 class；用 `a[href]` + 文本兜底。
8. 未登录访问 learn URL 会跳课程详情/首页，≠ 课程不存在。
9. 视频、题目、编辑器都可能在 iframe 里，每个动作都要「主框架 + iframe」两路找。
10. 判断题的 `true/false` 必须映射成「正确/错误」选项，不能直接点 A/B（llm-brain 按 true/false 输出）。
11. `page.eval` 注入的脚本要用 `String.raw` / 正确转义，正则里的 `\s`、`\/` 写错会让整段脚本语法错误。

## 9. 验证命令与结果（2026-11-10）

```powershell
node --check host/mooc.mjs                     # 通过
node -e "import('./host/mooc.mjs').then(m=>console.log(Object.keys(m).length))"   # 21 个导出
node scripts/mooc-inspect.mjs selfcheck        # 4/6 通过：登录状态/我的课程因未登录失败，符合预期
node scripts/mooc-inspect.mjs courses          # 清晰中文错误 + dump（未登录）
node scripts/mooc-inspect.mjs outline "https://www.icourse163.org/course/ZJU-199001"
                                               # 公开兜底：8 章、每周 video + homework
node scripts/mooc-inspect.mjs kind "第三章 单元测验"   # quiz
```

- `checkLogin` 修复后实测：分类页、首页都返回 `{"loggedIn":false,"needUser":null,"message":"还没有登录中国大学 MOOC"}`。
- `openLogin` + `fillLogin` 由 Lead 在 9233 实测成功（`#phoneipt` 与密码框写入，截图确认）。
- `selfCheck` 在未登录时对「登录状态」给「未登录（正常，需要先点登录）」而不是验证码误报。

## 10. 待验证清单（有真实账号后要补的）

1. 登录成功判定、滑块/短信验证/密码错误的真实表现与文案。
2. 「我的课程」真实 DOM、SPOC tab、课程卡片字段（老师/学期/进度）。
3. 学习页左侧章节菜单真实结构、单元链接格式（`#/learn/content?type=...&id=...` 或其它）。
4. 视频页 `<video>` 所在位置、字幕来源、播完是否自动跳下一节。
5. 测验/作业/考试页题目 DOM、提交确认弹窗、成绩页/错题解析。
6. 综合讨论区话题列表与发帖编辑器（是否富文本 iframe、是否要验证码）。
7. SPOC 学习页与 MOOC 学习页的差异。


## 9. 2026 新版 MOOC 站（2026-11-10 登录态实测，补记）

新版 MOOC 课程整套换成了 Next.js 前端，旧版 DOM 选择器（`.m-learnChapterNormal`、`.u-quizHwListItem` 等）只适用于 SPOC。
现在由 `host/mooc-web.mjs` 负责这一层，`host/mooc.mjs` 只保留登录与老 SPA 答题逻辑。

### 9.1 我的课程（RPC，MOOC + SPOC 通用）

- `POST /web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc?csrfKey=<NTESSTUDYSI>`
- body：`type=30&p=1&psize=30&courseType=1`（MOOC）/ `courseType=2`（SPOC）
- 返回 `result.result[]`：`id`（数字课程 id）、`name`、`shortName`（课程代码，如 1001ZJU021A）、`termPanel.id`（termId）、
  `termPanel.fromTermId`（SPOC 的源课程 termId）、`termPanel.startTime/endTime/lessonsCount`、`schoolPanel.name/shortName`、`learnedCount`、`mode`。
- **学习页 key 不是 `shortName`**：是「学校简称-课程数字 id」，例如 `ZJU-1003315004`。拼错会跳到错误页。
- SPOC 的课件/视频来自源课程：大纲接口要用 `termPanel.fromTermId`。

### 9.2 章节大纲（RPC，一次拿全）

- `POST /web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=…`，body `termId=<termId>`
- `result.mocTermDto.chapters[].lessons[].units[]`：`id`（unitId）、`name`、`contentType`（1=视频/媒体、3=章节内测验、6=讨论）、
  其中 contentType=6 表示「系统给这个课次挂了讨论要求」：只有这类课次才生成讨论任务（挂在课次最后一个视频后），
  没有讨论单元的课次不生成讨论任务；旧大纲刷新后会自动清掉多余的讨论任务。
  `lessonId`、`chapterId`、`durationInSeconds`、`completePercent`。
- 新版课件目录 DOM（折叠面板）是懒加载的：只展开一个章节时其它章节没有单元，**不要靠逐个展开读大纲**，用这个接口。
- 新版视频地址：`/mooc/learn/<key>/content/<lessonId>?tid=<termId>&unitId=<unitId>&chapterId=<chapterId>`
- 「测验与作业」页：`/mooc/learn/<key>/assessments?tid=…`，`.learn-assessment-week h3` 是周，`.learn-assessment-card` 里
  `.learn-assessment-title` / `.learn-assessment-deadline` / 链接 `#/learn/quiz?id=<quizId>`（仍是老答题 SPA）。
- 「考试」页：`/mooc/learn/<key>/exams?tid=…`，`.learn-exam-card[data-legacy-exam-card]`，链接 `#/learn/examObject?id=…&eid=…`。
- 新版页面**只有标签页可见时才加载数据**：读之前必须 `Page.bringToFront`（cdp `page.activate()`），否则一直是骨架屏。

### 9.3 新版讨论区

- 讨论区：`/mooc/learn/<key>/forum?tid=…`，右上「发起主题」`.forum-create-topic`，子板块「综合讨论区」。
- 发帖页可直接打开：`/mooc/learn/<key>/forum/topic?tid=…`；标题 `input[placeholder="请输入标题"]`，
  正文是 Quill：`.ql-editor[contenteditable=true]`（execCommand insertText 可写入），发布按钮「发布主题」。

### 9.4 SPOC（仍是老 SPA）

- 学习页：`/spoc/learn/<key>?tid=<termId>#/learn/...`
- 章节：`.m-learnChapterNormal`（`.j-titleName` 周名）；单元：`.sourceList .lsicon[data-cid="<unitId>"]`（点进去）。
- 测验：`#/learn/testlist`，`.u-quizHwListItem`，周标题在父级 `.m-chapterQuizHwItem .j-titleName`，
  `.j-name` 测试名，`.j-submitTime` 截止，`.j-submitCount` 有效提交次数，`.j-quizBtn` 前往测验（点后进入老答题页）。
- 考试：`#/learn/examlist`，`.u-quizHwListItem.eaxmListItem[id=<examId>]`，`.j-totalScore`。
- 视频播放器：页面里就是普通 `<video>`（blob 源），设置 playbackRate + play 即可，进度从 currentTime/duration 读。

### 9.5 仍未实测

- 老答题页（`#/learn/quiz?id=…` / `#/learn/examObject…`）的题目 DOM、选项点击、提交确认、成绩页：本模块沿用旧实现，
  需要用户第一次真做测验时验证（不要为了测试消耗用户的答题次数）。
- 真正发布讨论帖：只验证到「能打开、能填写、能找到发布按钮」，没有点发布。


## 10. 后台（无头）执行（2026-11-10 实测）

- Edge/Chrome 用 --headless=new --mute-audio --autoplay-policy=no-user-gesture-required 启动；
  同一个 rowser-profile 里的登录 Cookie 在无头模式照样有效（实测登录态可用）。
- 无头模式下 eadMyCourses（6 门）、eadOutline（16 章 99 单元）、视频 <video> 播放（currentTime 前进）都正常。
- 登录弹层/滑块必须可见窗口：所以「登录/打开页面」这些操作强制切可见浏览器；登录成功后切回无头。
- 无头浏览器听不到声音，任务执行时强制 ideoMuted=true，避免自动播放被拦截。
- 实测链路：只点「读取我的课程」→ service 自动启动无头浏览器 → 读到 6 门课程；
  再执行一个视频任务 12 秒 → 任务 running、进度 18%（视频 16%）、日志标「后台无头浏览器」、可取消。


## 11. SPOC 讨论区发帖流程（2026-11-10 实测）

- 讨论区入口：学习页左侧「讨论区」→ #/learn/forumindex；「发起主题」按钮是 .j-newTopicBtn。
- 点「发起主题」后 SPA 切到 #/learn/forumeasytopic，异步渲染 Quill 编辑器（.ql-editor[contenteditable=true]）。
- 发帖页必须先选板块：点「请选择主题所属板块」，再选弹出菜单里的「综合讨论区」；不选会校验失败。
- 标题输入框是 input.j-textarea.inputtxt（没有 placeholder 属性，页面上「请输入标题」只是视觉占位）；正文用 Quill 编辑器；「发表」按钮提交。
- 早期适配里没有识别「发起主题」，会去点旧文案/「发表」表格列，导致一直找不到标题/正文编辑框——发帖失败与前面的视频/任务顺序无关。

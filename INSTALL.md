# 安装与首次使用

> 这是 `ZJU-mooc-assistant` 的**可分发副本**：不含原作者的账号、Cookie、截图和个人路径。
> 本插件是 DeepSeek Harness（DSH）的本地插件，不是独立 App。
>
> 注意：副本和原版使用同一个插件 id（`ZJU-mooc-assistant`），
> 在同一个 DSH profile 里不要同时启用两个；装副本前先停用原插件。

## 1. 适用环境

| 项目 | 要求 |
| --- | --- |
| DSH | 桌面版，`dsh >= 0.2.1-rc.3 < 0.3.0`（更高版本可能装不上） |
| 操作系统 | Windows 10/11（已实测）；macOS / Linux 已加入浏览器路径查找，但尚未实机验证 |
| 浏览器 | Microsoft Edge 或 Google Chrome（Chromium 内核） |
| 模型 | DSH 里已选择默认模型，自动答题/讨论/总结需要它 |
| 账号 | 你自己的中国大学 MOOC（icourse163）账号，且已选修对应课程 |
| 课程范围 | 课程必须在 icourse163 上（SPOC 或 MOOC）；学在浙大/智云课程不支持 |
| 网络 | 能访问 icourse163；首次登录需要人工完成滑块/安全验证 |

同一台电脑多人使用：请各自使用自己的 Windows 账号（或设置不同的 `DSH_HOME`）。
插件数据按 `$DSH_HOME` 隔离，**不按 DSH profile 隔离**；同一个 Windows 账号下多个 profile 仍会共用账号、Cookie 和浏览器 Profile。

## 2. 安装

> 命名说明：对外包名/目录名/客户端注册 id/数据目录已统一成 `ZJU-mooc-assistant`
>（按显示名使用大写；npm 官方发布要求全小写，所以本包定位为 link/tarball 本地分发，不发布到 npm）；
> 内部 API 路径（`/api/mooc-companion`）和 slot id 仍保留历史 id；
> 旧数据目录 `$DSH_HOME/mooc-companion` 会在新版本第一次启动时自动迁移到 `$DSH_HOME/ZJU-mooc-assistant`，
> 已有登录态、任务和浏览器 Profile 都会保留。

先准备好插件目录，例如：

- Windows：`D:\tools\ZJU-mooc-assistant`
- macOS / Linux：`~/tools/ZJU-mooc-assistant`

### 方式 A：DSH profile 依赖里加本地链接

编辑你的 desktop profile 的 `package.json`（通常在 `$DSH_HOME/profiles/desktop/package.json`），把
`<插件目录>` 换成上面的真实路径：

```json
{
  "dependencies": {
    "ZJU-mooc-assistant": "link:<插件目录>"
  },
  "dsh": {
    "profile": {
      "bundles": ["ZJU-mooc-assistant"]
    }
  }
}
```

然后在 DSH 的「插件」页里安装/启用「ZJU-mooc-assistant」。

### 方式 B：在该 profile 目录下用 pnpm 加链接

```bash
cd <DSH_HOME>/profiles/desktop
pnpm add link:<插件目录>
```

### 方式 C：从 tarball 安装（如果拿到的是 `.tgz`）

```bash
cd <DSH_HOME>/profiles/desktop
pnpm add file:<插件目录>/dist/ZJU-mooc-assistant-0.2.1.tgz
```

安装或启用后，刷新 DSH 页面，左侧栏出现「ZJU-mooc-assistant」即可。

## 3. 首次使用

1. 打开插件页面。启动约 1 秒后，页面顶部会自动做一次**环境自检**：
   - 数据目录是否可写；
   - 是否找到 Edge/Chrome；
   - DSH 是否配置了默认模型；
   - 调试端口是否已被占用。
   有问题的项会以黄色提示直接显示，按提示先处理，再继续。
2. 点「打开中国大学 MOOC」，在弹出的可见浏览器窗口里打开课程页。
3. 在「账号与登录」里填自己的账号密码；点「保存账号」，再点「登录」。
   如果出现滑块/扫码/安全验证，请在浏览器窗口里手动完成，然后回页面点「刷新」。
4. 点「读取我的课程」；选择课程后点「刷新大纲」。
5. 先手动点一个视频「开始」，确认播放/登录正常，再使用「计划截止时间」批量排期。

## 4. 常见问题

- **提示没找到 Edge/Chrome**：安装浏览器，或到「设置 → 详细参数 → 浏览器路径」填完整可执行文件路径。
- **提示没有默认模型**：在 DSH 设置里选一个模型；没有模型时只能看课程，不能自动答题/写讨论。
- **调试端口被占用**：到「设置 → 详细参数 → 浏览器端口」换一个（如 9333）。
- **登录成功但很快掉线**：通常是站点风控/登录过期，重新点「登录」并完成验证；不要多台设备同时抢登录。
- **某个视频/题型卡住**：点「取消」，打开任务页面手动确认进度/题型后再重试；不支持监考、人脸识别等场景。

## 5. 数据来源与存放位置

### 5.1 数据来源

| 数据 | 从哪里来 |
| --- | --- |
| 账号、密码 | 你自己在插件页面输入；只提交给 icourse163 的登录页（`www.icourse163.org` / `reg.icourse163.org`） |
| 课程、章节大纲、视频进度、测验/作业/考试、讨论区 | 通过插件启动的 Edge/Chrome，用你自己的登录 Cookie 访问 icourse163 页面和接口读取 |
| 登录 Cookie / 浏览器会话 | icourse163 下发，保存在插件的浏览器用户数据目录里 |
| 视频字幕、课件要点、题干选项、讨论上下文 | 从 icourse163 页面读取；自动答题/写讨论/做总结时，这些内容会发送给**你在 DSH 里选择的默认模型**（provider/model 由你配置） |
| 称呼、倍速、浏览器路径、计划截止时间等 | 你自己在插件设置里填写 |
| 任务进度、课堂笔记、执行日志 | 插件运行过程中自己生成 |

插件没有作者自建服务器，也没有第三方统计或遥测上报。除 icourse163 和你在 DSH 配置的模型服务外，插件不主动向其他服务器发送数据。

### 5.2 存放在哪里

默认位置：

- Windows：`C:\Users\<你的 Windows 账号>\.dsh\ZJU-mooc-assistant\`
- macOS / Linux：`~/.dsh/ZJU-mooc-assistant/`
- 如果设置了 `DSH_HOME` 环境变量，则跟随 `DSH_HOME`。

目录结构：

```text
$DSH_HOME/ZJU-mooc-assistant/
├── account.json       # 账号；只有勾选「记住密码」时才包含密码（明文）
├── settings.json      # 称呼、倍速、端口、浏览器路径、模型思考强度等
├── state.json         # 课程、大纲、任务进度、课堂笔记/字幕、执行日志、登录状态
├── runtime.json       # 插件启动时间、端口、版本
├── browser-profile/   # 插件专用 Edge/Chrome 用户数据目录：Cookie、登录态、缓存
└── shots/             # 只在手动诊断/调试时生成的页面截图或文本快照
```

说明：

- **插件目录和安装包本身不含任何账号、Cookie、课程或任务数据**。当前安装包只有 20 个代码/文档文件；每个同学安装后都是从自己的空数据开始。
- 只要每个同学使用**自己的 Windows 账号**（或各自的 `DSH_HOME`），数据彼此隔离，不会读到原作者或其他同学的数据。
- 插件数据**按 `$DSH_HOME` 隔离，不按 DSH profile 隔离**：同一个 Windows 账号下开多个 DSH profile，仍然共用 `account.json`、Cookie 和任务状态。
- `browser-profile/` 里的 Cookie 可以免登录进入你的 icourse163 账号，属于敏感数据；`state.json` 里也有课程、字幕和笔记。
- Windows 下 `0600` 权限位不会像 Linux 那样生效，实际保护依赖 Windows 用户目录 ACL；公共电脑上建议不要勾选「记住密码」。

### 5.3 清理与备份

- 卸载插件**不会删除**数据目录；需要彻底清理时，退出 DSH 后删除整个 `$DSH_HOME/ZJU-mooc-assistant`。
- 备份/迁移时复制整个 `$DSH_HOME/ZJU-mooc-assistant`，但要按含密码/Cookie 的敏感数据对待。
- 只想清空账号和 Cookie、保留设置时，删除 `account.json` 和 `browser-profile/`，再重新登录。
- 自动播放、自动答题、自动发讨论可能触及课程/平台的学术规范，请先确认你的课程允许这类辅助；考试监考场景请勿使用。

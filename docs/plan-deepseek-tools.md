# DeepSeek 工具族接入计划（联网搜索 / TTS / ASR / OCR）

> 状态：已落地（2026-11-18，S1–S5 全部完成，落地情况与偏差见 §6）。对应 `RDP升级.md` 第 1 条。
> 范围：把上游 rikkahub 已有的 DeepSeek 联网搜索、语音合成、语音识别对齐进 RDP；按官方 OCR 文档新增「DeepSeek OCR」并挂进设置里的 OCR 栏目（可选开启）。
> 前置：`docs/dev-workflow.md`（§5 设置与导出、§6 验证纪律）、`reference/rikkahub-android`（已 ff-only 更新到 `41d77f1e`，含 `f361bbc1 feat(speech): 新增 DeepSeek 语音合成与语音识别`）。
> 约束：新能力默认关；关闭时行为与改动前逐字一致；验证只打本地 mock，不调用计费接口。

## 0. 一句话结论

四项里有三项（搜索 / TTS / ASR）是**移植**——上游安卓已经把协议写好、DeepSeek 也在 `@SerialName` 里正式登记了 `deepseek`，RDP 只是没跟上；第四项（OCR）是**新增能力**，官方只有 `POST /v1/tools/ocr` 这一个入口，RDP 现有「OCR 模型」是"挑一个视觉模型兜底"的语义，两者要并存而不是互相替换。

## 1. 现状与证据

| 能力 | 官方口径（已核文档） | 上游安卓实现 | RDP 现状 |
| --- | --- | --- | --- |
| 联网搜索 | `POST /v1/tools/search`：`query`(1–128) + `count`(1–50,默认 10) + 可选 `ori_question/localization/need_content`；响应 `results[].{rerank_score,title,url,snippet,summary,content,site_name,site_icon,date,authority}` | `search/.../DeepSeekSearchService.kt`：只发 `query`+`count`，取 `summary.ifBlank{snippet}`；scrape 走 `/v1/tools/fetch` 取 `{title,content}` | `pc-server/search/index.ts:416` 18 家分支，**无 deepseek**；`service-endpoints.ts:38` 未登记端点 |
| 语音合成 | `POST /v1/tools/tts`：`{text, voice_id(stella女声｜tide男声), format(wav｜pcm), filter_markdown(默认 true)}`；`pcm` = 24kHz/16bit/mono 裸流，音频在响应体流式返回 | `DeepSeekTTSProvider.kt`：请求 `format=pcm`，**故意不要 wav**——流式 WAV 头的长度字段不可靠，改由播放器自己补头；无模型名、无声速 | `media/tts-providers/registry.ts:105` 11 家在线 provider，**无 deepseek**；`pcm16ToWav` 工具已在 `registry.ts:30` |
| 语音识别 | `POST /v1/tools/asr`：multipart 只有 `file`（16bit PCM WAV 或 Ogg Opus）；响应 `{request_id, text, duration_ms}`；官方单次 ≤120 秒 / ≤8 MiB | `DeepSeekASRController.kt`：非流式，按 `segmentDurationSec` 或上限切段、每段包 WAV 上传、结果顺序拼接；配置字段 `apiKey/baseUrl/sampleRate/segmentDurationSec` | `media/asr.ts` 已有 MiMo 的同一形态（HTTP 分段伪实时 + 文件转写），**无 deepseek**；`PC_KNOWN_ASR_TYPES` 在 `foundation/types/index.ts:219` |
| OCR | `POST /v1/tools/ocr`：multipart **只两字段** `file`(带文件名) + `purpose`(`text_recognition`｜`rich_layout_recognition`)，多余字段 400；支持 PDF/DOC(X)/PPT(X)/PNG/JPEG/WebP/GIF/BMP/TIFF；≤100 MiB、≤1000 页、总时长 180s；响应 `{id,object,created,purpose,page_count,pages[].{index,text,finish_reason},usage}`，识别期失败**仍是 200 + `error` 对象**；计费 1.5 元/1000 页、单账号 15 并发 | 上游**没有** OCR 工具 API 的实现（安卓 OCR = 视觉模型 `OcrTransformer.kt`） | 设置项只有 `ocrModelId`/`ocrPrompt`（`foundation/types/settings/model-config.ts:15`），运行时在 `conversations/auxiliary.ts:317-458`（"报错档"语义）；文档附件全文走本地 MuPDF 子进程 `files/extraction.ts:70` |

跨端契约（必须同步，否则备份往返即崩）：`foundation/types/android-contract.ts` 的三份 vendored 全集要各加 `deepseek`。上游实测全集（刚从 `41d77f1e` 的 Kotlin 源码提取核对）：搜索 20 家、TTS 13 家、ASR 6 家，均比 vendored 快照多的就一个 `deepseek`。

> 顺带发现的既有漂移（**不在本次范围**）：上游 `UIMessagePart` 已有 `notice` 判别符，vendored 快照没有。本机缺 `Reference-project/Rikkahub-Android`（`.gitignore:66` 忽略该目录），核对层只出警告不红，所以这条一直没被机器抓住。本次不动它，只在验收时口头报给决策。

## 2. 目标与非目标

### 2.1 做完后用户能做的事

- 在「设置 → 联网搜索」里把服务切成 DeepSeek，填一个 Key 就能让模型用 `search_web` / `scrape_web`，还能点「测试连接」。
- 在「设置 → 语音」里新增 DeepSeek 合成/识别服务：朗读用 stella/tide 两个音色，听写按分段上传出字，语音模式照常可用。
- 在「设置 → 模型 → 场景模型 → OCR」里打开 DeepSeek OCR 开关、填官方 Key，此后图片走官方 OCR；文档附件只在本地解析读不出来（扫描版 PDF、老 DOC/PPT）时才升级给官方 OCR，纯文本型文档照常免费本地读。官方接口挂了自动回落到已配的视觉模型 OCR。
- 以上配置经 PC↔APP 备份往返不被没收，也不会把 OCR 的 Key 带进 APP 备份。

### 2.2 本期不做

- 不接 WebSocket 版 TTS（`wss://api.deepseek.com/v1/tools/tts`）——RDP 现有 TTS 骨架是"整段拿音频"，流式增量属于另一件事。
- 不给 DeepSeek OCR 做自定义中转地址（按决策：官方服务、只填 Key，没填就用不了）。
- 不接 OCR 的 `<｜ref｜>/<｜box｜>` 坐标标记做图片裁切/定位，原样保留文本。
- 不做 EPUB 的 OCR（官方格式表里没有 EPUB），EPUB 与纯文本继续走本地解析。
- 不改 `pi/` vendor，不动其它搜索/语音供应商的行为。

## 3. 决策记录（已拍板）

1. **OCR 凭据**：OCR 栏目单独一个 API Key 输入框，只认 DeepSeek 官方接口，不复用聊天供应商的 Key、不给中转地址；未填 Key 时开关视为未生效并给出明确错误。
2. **OCR 接管范围**（用户追加口径：「扫描件才走 OCR，纯文本的直接发模型就能读，不需要 OCR」）：图片沿用现有触发条件；文档附件只在「本地解析读不出来」时才升级给 OCR——纯文本型文档照常本地读，不调用、不花钱（口径表见 §4.4）。
3. **OCR 失败口径**：官方接口失败 → 自动回退到「OCR 模型」里配的视觉模型；回退原因写进请求日志与错误中心留痕，不静默吞掉。
4. **默认关**（房规 §5）：`deepseekOcrEnabled` 默认 `false`，关掉时 OCR 行为与现在逐字一致。搜索/TTS/ASR 是新增供应商选项，不默认选中，加进去不改变现有生效选择。
5. **计费透明**：OCR 开关的描述里写明「1.5 元/1000 页，按识别成功的页数计费，客户端断开不取消识别、仍计费；扫描件每个文件只 OCR 一次（旁车缓存），纯文本型文档不会被送去 OCR」。

## 4. 落地拆解

### S1 DeepSeek 联网搜索（移植）

- `pc-server/search/service-endpoints.ts:38` 登记 `deepseek: { base: "https://api.deepseek.com", search: "/v1/tools/search", fetch: "/v1/tools/fetch" }`（免费拿到"换根不换路径"与中转标识）。
- `pc-server/search/index.ts`：`runSearchWeb` 新增分支（`withSearchKeyFailover` + `addLog kind:"tool:search_web"`），body 只发 `{query, count}`（与安卓一致，`need_content` 不开），`text = summary || snippet`；`runScrapeWeb` 新增分支 `{url}` → `{url,title,text: content.slice(0,12000)}`；`testSearchService` 新增分支（`query:"RikkaHub", count:1`）。
- 预设与回填：`app-config/defaults.ts:172`、`persistence/state-load.ts:455` 各加一条 `{ type:"deepseek", name:"DeepSeek", apiKey:"" }`，位置对齐安卓 TYPES（serper 之后）。
- 前端：`web-ui/app/components/settings/search.tsx:59,83` 加标签与可创建类型（字段区沿用通用 API Key / 结果数量 / 请求地址，无需新控件）。
- 契约：`foundation/types/android-contract.ts:32` += `deepseek`。
- 验收：`search/service-endpoints.test.ts` 覆盖新条目与完整端点粘贴幂等；新增 `search/deepseek.test.ts` 用本地 mock fetch 断言请求体、结果映射、`error.message` 抛错；`backup/android-contract-sync.test.ts` 分类层绿。

### S2 DeepSeek TTS（移植）

- `media/tts-providers/registry.ts:105` 新增 `deepseek` spec：`${trimBase(p.baseUrl)}/v1/tools/tts`、Bearer、body `{text, voice_id: p.voiceId || "stella", format: "pcm"}`、`parse = pcm16ToWav(整段响应, 24000, 1)`、mime `audio/wav`。**取 pcm 自补头**的理由与安卓同源：流式 WAV 的长度字段不可信。
- `foundation/types/index.ts:255` 判别符加 `"deepseek"`；`media/tts.ts:18 defaultTtsProvider` 加 `DeepSeek TTS`（`baseUrl: "https://api.deepseek.com"`、`voiceId: "stella"`，字段名与安卓 `TTSProviderSetting.DeepSeek` 逐字一致，备份互通）。
- `web-ui/app/components/settings/speech-catalog.ts:186` 加 `deepseek` 条目：`baseUrl`/`apiKey` + `voiceId` 下拉（stella 女声 / tide 男声）；不加速度/语种（官方没有）。
- 契约：`android-contract.ts:48` += `deepseek`。
- 验收：`registry.test.ts` 逐字节锁定 endpoint/headers/body；`web-ui/app/tests/speech-catalog.test.ts` 锁「模板 ≡ 后端默认」。

### S3 DeepSeek ASR（移植，复用 MiMo 的 HTTP 分段机器）

- `foundation/types/index.ts:219 PC_KNOWN_ASR_TYPES` += `"deepseek"`（安卓已正式登记，方向仍是 PC ⊆ APP）；契约文件 += `deepseek`。
- `media/asr.ts`：`defaultAsrProvider("deepseek")` = `{name:"DeepSeek ASR", baseUrl:"https://api.deepseek.com", sampleRate:16000, segmentDurationSec:30, websocketUrl:""}`（字段名对齐安卓）。
- 把 MiMo 私有的「HTTP 分段」判定抽成 `isSegmentedHttpAsr(type)`（mimo｜deepseek），三处消费点 `sendAsrAudio:592`、`startAsrRealtimeSession:657`、`stopAsrRealtimeSession:736` 的 `type === "mimo"` 换成该判定；上传函数按类型分派请求构造（MiMo = `chat/completions` + `api-key` 头；DeepSeek = multipart `file` + Bearer，解析 `{text}`）。分段缓冲字段名 `mimoPcm/mimoFlushing/mimoStopped` **不改名**（避免无关重构），在注释里登记两家共用。
- 文件转写：官方只吃 16bit PCM WAV / Ogg Opus，本机无 ffmpeg 不转码 → `.mp3/.m4a/.webm` 给明确人话错误（与 MiMo 现有拒绝同口径）。
- 上限：沿用 `mimoSegmentBytes` 的 min(时长, 6 MiB) 逻辑，天然满足官方 120 秒 / 8 MiB。
- 前端：`speech-catalog.ts:760` 加 `deepseek`（baseUrl/apiKey/sampleRate 下拉 8000/16000/22050/24000/32000/44100/48000 + segmentDurationSec 滑杆，无 model/language）。
- 验收：`media/asr.test.ts` 加 multipart 字段集（只 `file`）、`{text}` 解析、非 wav/ogg 拒绝、分段拼接；`asr-ws-frame.test.ts` 走一遍 deepseek 分段。

### S4 DeepSeek OCR（新增，PC-only）

- 新模块 `pc-server/media/ocr.ts`：`recognizeWithDeepSeekOcr({bytes, fileName, purpose})` → 拼 `pages[].text`，返回 `{text, pageCount, usage, incompletePages}`。要点：multipart 只发 `file`+`purpose`（多发字段官方 400）；`>100 MiB` 上传前直接拒；超时 200s（官方总时长 180s 后留余量）；**200 + `error` 对象**也判失败；`finish_reason:"length"` 的页在日志里标记；`addLog kind:"provider:ocr"` 记页数与 usage。
- 设置项（`foundation/types/settings/model-config.ts`，三个新键）：`deepseekOcrEnabled: boolean`（默认 false）、`deepseekOcrApiKey: string`、`deepseekOcrPurpose: "text_recognition"|"rich_layout_recognition"`（默认 text_recognition）。`app-config/defaults.ts` 给默认、`persistence/state-load.ts` 归一（布尔严格判 true、purpose 白名单回落、key trim）。
- API：`api/handlers/settings.ts:979` 的 `settings/default-models` 按字段合并（布尔缺省不动现值、purpose 白名单校验）。
- 备份：三键登记 `backup/import.ts:77 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT`；`backup/export.ts:275` 的 to-android 剥离块 delete 三键（Key 属凭据，不进 APP 备份），同步补进 `android-import-settings.test.ts` 的剥离断言列表。
- 图片通道：`conversations/auxiliary.ts:322 fetchAuxiliaryOcrText` 前置一层——开关开 + Key 已填 + 图片 mime ∈ PNG/JPEG/WebP/GIF/BMP/TIFF 时先走官方 OCR；失败或格式不支持 → 回落现有视觉模型路径（现有代码原样保留），并在 part metadata 记 `ocrEngine`、失败原因 `reportError("provider","info",…)` 留痕。开关开但 Key 空 → 抛「已开启 DeepSeek OCR 但未填 API Key」。
- 文档通道：本地解析**照常先跑**，DeepSeek OCR 只做「本地读不出来才补」的升级档，触发口径见 §4.4——纯文本型文档一律不花钱。
- UI：`web-ui/app/components/settings/default-models.tsx:420` 的 OCR 行下方补一组行（抄 `compressModelId` + `chatAutoCompact` 的卡内折叠写法，`default-models.tsx:505`）：开关行直接放；开关打开才展开 API Key 输入与用途下拉；描述写明计费与回退口径。`ocrModelId` 下拉保持可见（它就是回退引擎）。
- i18n：`web-ui/app/locales/{zh-CN,en-US}/settings.json` 补 `models.feature.ocr.deepseek_*`；`settings-search-index.ts:195` 附近补索引行（否则 `settings-search-index.test.ts` 红）。
- 验收：新增 `media/ocr.test.ts`（mock fetch：字段集、purpose 白名单、200-with-error、pages 拼接、超限拒绝）+ `auxiliary` 回退顺序用例；合并与校验语义并进既有的 `api/default-models-toggles.test.ts`（同端点同族语义，不另开文件，见 §6.3）。

#### 4.4 文档附件的 OCR 触发口径（按用户拍板：只有扫描件才花钱）

判定发生在提取子进程跑完之后、单一决策点（`runExtractionChild` 收尾处），不新增并发池、不重试、旁车缓存天然防重复计费：

| 附件类型 | 本地解析（现状，免费） | 什么时候才调 DeepSeek OCR |
| --- | --- | --- |
| PDF | MuPDF 逐页结构化文本 | 本地结果为空，或**文本密度低于 30 个非空白字符/页**（正常排版中文 PDF 一页 500～1500 字；扫描件往往只漏出水印/页码几个字，光判"空"会漏掉带水印的扫描件） |
| DOC / PPT（老二进制） | 本地**根本不解析**，现在只能拿到"读不到内容"的占位提示 | 无条件走 OCR（这档正是官方 OCR 相对本地解析的净收益） |
| DOCX / PPTX | 自家 XML 拉取解析（对齐安卓），正常都能出全文 | 仅当本地提取完全为空（整篇是贴图的文档） |
| EPUB / 纯文本类 | 本地解析，官方格式表里也没有 EPUB | 永不 OCR |

配套改动：`registry` 完成态要留住页数（现在 `{status:"done"}` 把 progress 的 `total` 抹掉了），密度判定要用；OCR 升级期间状态回 `pending`，前端进度圆圈不会提前判"无文本"。开关关或 Key 未填 → 整张表都不生效，行为与现在逐字一致。

### S5 回归与文档

- `cd pc-server && bun run typecheck` + 目标测试逐文件跑；`cd web-ui && bun run typecheck && bun test app`。
- 基线对照：已知 Windows 恒定 2–3 项 EPERM/EBUSY flake 不算回归（房规 §6）。
- 前端改动 build 后重启 17455 demo 冒烟（房规 §4/§8，走 `demo-server.sh`）。
- 全部验证只打本地 mock（`127.0.0.2:18124`），**不碰真实 DeepSeek 接口**——四项都计费，真机验收由你来点「测试连接」。
- 变更说明只写条目（发布说明口径），README 功能列表补一行。

## 5. 风险与已知限制

- DeepSeek 工具族与聊天模型共用同一个 Key、同一份余额：搜索/OCR/TTS/ASR 任一开启即可能消耗余额，`402 余额不足` 会原样透到人话错误里。
- OCR 按页计费且「客户端断开不取消识别」，所以并发要克制：文档 OCR 复用现有并发上限 2，图片 OCR 逐 part 串行，不引入新并发池。
- 官方单次 120 秒音频上限意味着长录音必然分段，分段处可能切断句子（安卓同款限制）——分段阈值默认 30 秒，可调 0–60。
- `webm` 录音走 DeepSeek 文件转写会因格式被拒（无转码器）；实时听写不受影响（前端本来产 PCM16，服务端包 WAV）。

## 6. 落地情况与验收（2026-11-18）

S1–S5 全部落地，四项能力都可用且**默认关**（OCR 开关默认 `false`；搜索/TTS/ASR 只是新增可选项，不改变现有生效选择）。

### 6.1 测试清单（全部只打本地 stub，未调用任何 DeepSeek 计费接口）

| 文件 | 条数 | 锁什么 |
| --- | --- | --- |
| `pc-server/search/deepseek.test.ts` | 5 | search/fetch 报文、`summary→snippet` 回落、count 夹 1–50、非 2xx 人话错误、测试连接逐 Key |
| `pc-server/media/tts-providers/registry.test.ts` | +2 | `/v1/tools/tts` 的 endpoint/Bearer/body，**取裸 PCM 自补 WAV 头**的字节级形状 |
| `pc-server/media/asr-deepseek.test.ts` | 8 | multipart 只 `file`、顶层 `text`、非 WAV/OGG 拒绝、120 秒与 8 MiB 上传前挡、分段阈值与拼接、家族判定 |
| `pc-server/media/ocr.test.ts` | 12 | multipart 只 `file`+`purpose`、purpose 白名单、200-with-`error` 判失败、保活换行、pages 拼接与截断页、100 MiB 与缺 Key 零出网、图片/文档白名单 |
| `pc-server/files/extraction-ocr-escalation.test.ts` | 9 | §4.4 那张表：空→`empty`、密度<30 字/页→`sparse`、正常排版→不升级、页数未知只认全空、EPUB/纯文本永不、开关关或 Key 空整表失效 |
| `pc-server/conversations/auxiliary-ocr-fallback.test.ts` | 8 | 图片三档编排：开关关＝逐字旧行为、开关开走官方、失败/空文本自动回落视觉模型并在错误中心留痕、缺 Key 不换引擎、两截原因合并、模型看得见图则整链不动、已有 `ocrText` 不重烧 |
| `pc-server/api/default-models-toggles.test.ts` | +6 | 三字段合并语义：缺省不动现值、Key 显式空串真删、purpose 值域外不覆盖、半成品状态可存 |
| `pc-server/backup/android-import-settings.test.ts` | 改动 | 三键在安卓导入侧保留、导出侧 `deepseekOcrApiKey` 被剥（凭据不进 APP 备份），`enabled/purpose` 照旧透传 |
| `pc-server/media/asr.test.ts`、`backup/android-contract.test.ts`、`search/service-endpoints.test.ts` | 改动 | 跨端保真（step 仍原样保留）、已知类型计数 |

### 6.2 验证结果

- `pc-server`：`bun run typecheck` 我们侧 0 错误（已滤除 pi 内部诊断 46 条）；全量 `bun test` **2769 pass / 2 fail / 16 skip**。两条红是本机已知 flake——`workspace/boundary` 与 `workspace/runtime` 要往 `C:\WINDOWS\Temp\rkh-allow-test.txt` 真写文件，非管理员身份直接 `EPERM`，与本专题无关（房规 §6）。
- `web-ui`：`bun run typecheck` 0 错误；`bun test app` **579 pass / 1 fail**——唯一一条红是本专题之外的问题（见 §6.4）。本专题新加的索引行与 locale 同义词键全绿。
- 17455 demo 已按房规重编重启（`demo-profiles/tools/demo-server.sh run --build`）：`/api/health` ready，`GET /api/settings` 对老 state.json 回显出三个新字段（归一生效），产物 bundle 里能搜到 OCR 卡片的新文案。

### 6.3 与计划的偏差（三条，均为实现期决定）

1. **`metadata.ocrEngine` 没做**：计划里想在图片 part 上记引擎名，但前端与后端都没有消费点，加了就是死字段。引擎与回落证据改由两处承载：请求日志 `kind:"provider:ocr"`（含 purpose、页数、usage）与错误中心的 `deepseek_ocr_fallback`（info 级）。
2. **`api/default-models-ocr.test.ts` 没另开文件**：三字段与既有的开关/场景档是同一端点同一族语义，直接并进 `default-models-toggles.test.ts`，避免第二个文件重复搭 `handleSettingsRoutes` 的脚手架。
3. **搜索索引的同义词是 locale 键**，不是自由文本：`row(..., { keywords: "x" })` 的 `x` 会拼成 `settings:nav_search.keywords.x`，两份 locale 都要有。新加 `deepseek_ocr` / `ocr_purpose` 两键（中英各一份），Key 行复用现成的 `api_key`。

### 6.4 本专题之外发现的问题（留给对应会话）

- `settings-search-index` 的全覆盖锁报 3 行未登记：`models.feature.compress.budget_{aging,keep,excerpt}_title`。这是「压缩预算」那组新行（并行会话的产物）没进索引，不是 DeepSeek 专题的行；修法与 §6.3 第 3 条同款，交给那边补。
- 上游安卓的 `UIMessagePart` 已有 `notice` 判别符，本机 vendored 快照没有（§1 注）。本机缺 `Reference-project/Rikkahub-Android` 那份检出，核对层只警告不红，所以这条漂移没被机器抓住——本次按口径手工核对了三份 `@SerialName` 全集，未把 `notice` 一起拖进来。

### 6.5 还需要你来点的验收

- 设置里真机开启：搜索/TTS/ASR 各点一次「测试连接」，OCR 打开开关填 Key 后拿一张真扫描件与一个老 `.doc` 试一次（**这一步会真花钱**：1.5 元/1000 页）。
- 备份往返：APP→PC 导入带 `step` 语音服务的配置不被没收；PC→APP 导出不带 OCR 的 Key。
- 便携版与 Docker/NAS 实跑（`qwen`/`deepseek` 这类在线 provider 在容器里同样只依赖出网）。

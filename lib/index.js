// dsh-work-diary - host half (static package)
// 静态包差异：无 harness builtin，用 webServer 前缀路由
//   POST /dsh-work-diary/api/<op>  (op: saved | sessions | collect | start | poll | settings.get | settings.set | models)
// 职责：按天读会话（sessionQuery）-> 把当天的事件切成轮次并按项目分段
//       -> 每个项目一次 llm.stream，再合并成整份日记 -> 内存 run 供前端 poll
//       -> 定时自动执行与启动补跑 -> 设置/结果落盘。
// 读会话一律走 sessionQuery，禁止自行解析原始会话文件。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const API_PREFIX = '/dsh-work-diary/api'
const EMPTY_TEXT = '今天还没有会话记录。'
const MAX_RUNS = 8
const MAX_SAVED_RUNS = 30
const LOG = '[dsh-work-diary]'

const DEFAULT_SETTINGS = {
	enabled: true,
	time: '18:00',
	provider: '',
	model: '',
	language: 'zh',
	verbosity: 'brief',
	maxSessions: 40,
	roundsPerSession: 50,
}

// 省 token 的两档。两档现在只影响「输出侧」和会话头：取样口径（每轮 50/200 字、
// 首 25% / 中 50% / 尾 25%）是共用的常量，不随档位变。原因很简单：两档写的是
// 同一天的日记，读者会拿它们互相参照，输入口径一歪，同一件事在两档里就会长成
// 两个样子，那不叫「详细程度」，叫「两套事实」。
//
// maxTokens 是输出硬顶，必须同时装下「思考」和「正文」两段。
// 2026-10-28 实测（真实 digest + 10-27 六会话，brief 档）：
//   max_tokens=900  → finish=length、content=0，八个参测模型全部出空。
//     思考长度在 1500-6600 字之间剧烈波动，900 额度在吐正文前就被吃光。
//   max_tokens=4000 → finish=stop、content=724 字、completion_tokens=2605。
// 思考 token 压不掉：网关不转发 reasoning_effort / enable_thinking /
// thinking.type，六种关思考写法实测一个都没真关（reasoning_effort=none
// 在真实 prompt 上反而让思考飙到 6536 字）。所以只能按思考上界给额度。
// 字数约束仍然靠提示词：brief 要求不超 600 字、full 不超 800 字，
// 实测 4000 额度下正文落在 720-1000 字之间，基本服管。
//
// sectionChars 是「按项目拆出去的那一段」的上限。拆成多次请求后每段都要单独
// 收口，否则各段加起来会把合并请求顶到需要再裁一遍。maxChars 是合并后的总长。
// 分项目请求同样按 maxTokens 给额度：思考长度与输入长度无关，压额度只会换来空正文。
const VERBOSITY_PRESETS = {
	brief: { keepCwd: false, maxChars: 600, sectionChars: 300, maxTokens: 4000, openItems: false },
	full: { keepCwd: true, maxChars: 800, sectionChars: 400, maxTokens: 6000, openItems: true },
}

// 每轮送模型时的截断额度。用户输入一句话就说完，50 字足够表达「要干什么」；
// AI 结论 200 字基本覆盖「做成了什么」，而一条完整答复常有上千字，整条送进去
// 等于把额度花在细节上。两档共用：档位只该改输出详略，不该偷偷改输入口径。
const ROUND_USER_CHARS = 50
const ROUND_AI_CHARS = 200
// 轮次正文在 item 里的原文上限。digest 只截到 50/200，但 item 会整包留在
// collectCache 里（一天上千轮的会话真实存在），留 500 字够 digest 用，又不至于
// 把整场助手正文都揣在内存里。
const ROUND_RAW_MAX = 500
// 抽样比例：首 25% 全取、中 50% 均匀抽样、尾 25% 全取。写死不进设置：比例一改，
// 「保留多少轮」这个数字的含义就变了，而用户调的是轮数不是比例。
const ROUND_HEAD_PCT = 0.25
const ROUND_TAIL_PCT = 0.25
// 分项目生成时的并发。三个请求同时在飞：再多只是把网关排队的时间挪过来，
// 还会让进度文字跳得厉害。
const PROJECT_CONCURRENCY = 3

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		req.on('data', (c) => chunks.push(c))
		req.on('end', () => {
			try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
			catch (e) { reject(e) }
		})
		req.on('error', reject)
	})
}

function dshHome() {
	const raw = process.env.DSH_HOME
	if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
	return join(homedir(), '.dsh')
}

function baseDir() {
	return join(dshHome(), 'work-diary')
}

function settingsFile() {
	return join(baseDir(), 'settings.json')
}

function lastRunsFile() {
	return join(baseDir(), 'last-runs.json')
}

// 读 JSON：任何异常都当成「没有」，调用方用默认值兜底。
function readJson(file) {
	try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return null }
}

// 写 JSON：先写临时文件再 rename，避免进程中断留下半截文件。
function writeJson(file, value) {
	try {
		mkdirSync(dirname(file), { recursive: true })
		const tmp = file + '.' + process.pid + '.tmp'
		writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
		renameSync(tmp, file)
		return true
	} catch (e) {
		console.error(LOG, 'write failed:', file, (e && e.message) || String(e))
		return false
	}
}

function clampInt(v, min, max, fallback) {
	const n = typeof v === 'number' ? v : parseInt(v, 10)
	if (!Number.isFinite(n)) return fallback
	return Math.max(min, Math.min(max, Math.floor(n)))
}

function sanitizeSettings(raw) {
	const out = Object.assign({}, DEFAULT_SETTINGS)
	const src = (raw && typeof raw === 'object') ? raw : {}
	if (typeof src.enabled === 'boolean') out.enabled = src.enabled
	if (typeof src.time === 'string') {
		const m = /^(\d{1,2}):(\d{2})$/.exec(src.time.trim())
		if (m) {
			const h = parseInt(m[1], 10)
			const mi = parseInt(m[2], 10)
			if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) out.time = (h < 10 ? '0' + h : String(h)) + ':' + m[2]
		}
	}
	if (typeof src.provider === 'string') out.provider = src.provider.trim()
	if (typeof src.model === 'string') out.model = src.model.trim()
	if (src.language === 'en' || src.language === 'zh') out.language = src.language
	if (src.verbosity === 'brief' || src.verbosity === 'full') out.verbosity = src.verbosity
	out.maxSessions = clampInt(src.maxSessions, 1, 200, DEFAULT_SETTINGS.maxSessions)
	// 非数字 / 空值回退默认，数字夹到 1-200 之间（与 maxSessions 同一套钳位口径），
	// 不让一次手误把每天的 digest 变成空的或者几十万 token
	out.roundsPerSession = clampInt(src.roundsPerSession, 1, 200, DEFAULT_SETTINGS.roundsPerSession)
	return out
}

function loadSettings() {
	return sanitizeSettings(readJson(settingsFile()))
}

function pad2(n) {
	return n < 10 ? '0' + n : String(n)
}

function localDateStr(date) {
	return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

function hm(ms) {
	const n = Number(ms)
	if (!Number.isFinite(n) || n <= 0) return '--:--'
	const d = new Date(n)
	return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

// 会话一个常常跨好几天（10-26 当天 13 个会话里 7 个是早几天创建、今天继续干的）。
// digest 现在传的是「当天首末事件」，正常情况下两端同一天；跨天分支留着兜底，
// 免得某条事件时间戳异常时把「10-23 17:46 到 10-26 17:35」显示成 17:46-17:35
// 那种看着倒挂的样子。与客户端 hmRange 同一套规则。
function hmRange(fromMs, toMs) {
	if (!(fromMs > 0)) return hm(toMs)
	const a = new Date(fromMs)
	const b = new Date(toMs)
	const sameDay = a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate()
	if (sameDay) return hm(fromMs) + '-' + hm(toMs)
	const md = (d) => (d.getMonth() + 1) + '-' + d.getDate()
	return md(a) + ' ' + hm(fromMs) + ' - ' + md(b) + ' ' + hm(toMs)
}

function truncate(text, max) {
	if (typeof text !== 'string') return ''
	return text.length <= max ? text : text.slice(0, max) + '…'
}

// 一轮里的用户输入经常不是工作内容，而是客套、追问，或者整段粘进来的代码表格。
// 现在它只决定「这一轮要不要单独占一行 用户: 」——AI 结论照样送，因为「继续」
// 之后那条结论往往正是这一轮的实际产出，把整轮丢掉等于把产出一起丢掉。
//
// 中文不能靠 \b 收尾：JS 的 \b 只认 [A-Za-z0-9_]，汉字两侧都不算词边界，所以
// /^(谢谢|继续)\b/ 这种写法对中文整个失效（正是上一版「继续」「好的」照发的
// 原因）。改成「去掉标点后整句只由客套词拼成」才算噪声——「好的，帮我把这个
// 改一下」这种带正文的不会被误杀，「好的谢谢」会。
const ACK_ONLY_RE = /^(?:谢|感谢|多谢|好|好的|好滴|好吧|好呀|行|可以|嗯|收到|辛苦|完美|不错|赞|厉害|继续|接着|没事|不用了|算了|ok|okay|yes|yeah|no|nope|thanks|thx|done|go|continue|next)+$/i

function isBareAck(text) {
	const core = String(text).replace(/[\s，。、,.!！?？~～…;；:：'"“”‘’()（）\[\]【】*_-]+/g, '')
	// 只剩标点（「？」「。。。」）也等于没说
	if (core === '') return true
	return ACK_ONLY_RE.test(core)
}

// 代码判据只看首词会误杀正常诉求：select / delete / from / update 都是合法英文
// 句子开头（"delete the temp files"、"from this file remove X"）。所以首词命中
// 之后还要求近处出现代码标点；或者整体是多行且带语句结尾分号/花括号。
const CODE_KEYWORD_RE = /^\s*(?:private|public|protected|friend|const|let|var|function|def|class|import|from|#include|package|using|namespace|select|insert|update|delete|create|alter|drop)\b/i

function looksLikeCode(text) {
	const t = typeof text === 'string' ? text : ''
	if (t === '') return false
	const lines = t.split('\n')
	const first = lines[0] || ''
	// 围栏代码块
	if (/^\s*```/.test(first)) return true
	// 预处理指令
	if (/^\s*#(?:include|define|ifndef|ifdef|pragma|endif)\b/.test(first)) return true
	const keyword = CODE_KEYWORD_RE.test(first)
	if (!keyword) {
		// 不是关键字开头：多行 + 行尾分号/花括号 + 出现赋值或调用，才算整段代码
		return lines.length >= 3 && /[;{}]\s*$/m.test(t) && /[=(){]/.test(t)
	}
	// 关键字开头：首行近处有语句标点（const X = 1 / import { a } / using System;）
	if (/[=;{}]/.test(first.slice(0, 80))) return true
	// 函数调用写法：标识符紧跟左括号（f() / foo(bar)）。允许中间有空格会把
	// 正常英文的「files (in /tmp)」也算进来，所以这里不放宽
	if (/\w\(/.test(first)) return true
	// select * from / delete * 这类 SQL 的星号
	if (/\*/.test(first)) return true
	return lines.length >= 3 && /[;{}]/.test(t)
}

// 短追问（「所以问题出在哪里？」）描述的是疑问不是工作。三道闸门同时成立才算：
// 疑问性开头 + 疑问语气收尾 + 短。刻意不收「为什么 / 怎么 / 这个」开头——
// 「为什么并发是 4」本身带着排查对象，是有信息量的诉求，误杀的代价比省钱大。
const ASK_START_RE = /^(?:所以|那|那么|然后|还有|接下来|下一步|是不是|有没有|是否|这样|那样)/
const ASK_TAIL_RE = /[吗呢么？?]\s*$/

function isShortFollowUp(t) {
	return t.length < 20 && ASK_TAIL_RE.test(t) && ASK_START_RE.test(t)
}

// 粘进来的日志 / 报错栈 / curl 命令。这类东西在真实数据里是最长的「诉求」，
// 10-26 实测三个 501 字段的会话，最长的一条全是日志（`email_analysis - INFO -
// 开始处理请求`、`SalesIntegrationError WARNING`、`curl --location --request POST`）。
// 现在每轮只留 50 字，粘贴物占的不是额度而是位置：它把那 50 字全用在自己身上，
// 一句「要干什么」就被挤掉了。
// 中文占比是最好用的判据：真人诉求再短也是中文句子，日志和命令几乎纯 ASCII。
// 阈值取 0.25：实测真实诉求的中文占比都在 26% 以上，日志/命令/含密码的粘贴
// 都在 1% 到 12%，两边分得很开。
function looksLikePaste(text) {
	const t = typeof text === 'string' ? text.trim() : ''
	if (t.length < 60) return false
	const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
	return cjk / t.length < 0.25
}

function isNoisePrompt(text) {
	if (typeof text !== 'string') return true
	const t = text.trim()
	if (t === '') return true
	// 太短的根本承载不了意图（4 字是「跑一下测试」的下限，再长就可能是真指令）
	if (t.length < 4) return true
	// 整句只有客套词
	if (isBareAck(t)) return true
	// 短追问
	if (isShortFollowUp(t)) return true
	// 整段粘进来的代码
	if (looksLikeCode(t)) return true
	// 整段粘进来的日志 / 命令 / 表格数据
	if (looksLikePaste(t)) return true
	// 整段粘进来的表格数据（至少三列分隔的制表符 + 长文本）
	if ((t.match(/\t/g) || []).length >= 3 && t.length > 80) return true
	return false
}

// 标题判据单独一套。DSH 的标题通常很短（「git 版本」6 个字），直接复用
// isNoisePrompt 的长度阈值会把大半正常标题判成噪声、全部退回项目名，
// 摘要头就再也分不出会话了。标题只排「客套整句」「代码」「过长粘贴」。
function isNoiseTitle(text) {
	if (typeof text !== 'string') return true
	const t = text.trim()
	if (t === '') return true
	if (isBareAck(t)) return true
	if (looksLikeCode(t)) return true
	// 标题不该是一段正文
	if (t.length > 80) return true
	return false
}

function toMs(v) {
	if (typeof v === 'number' && Number.isFinite(v)) return v
	if (v instanceof Date) return v.getTime()
	if (typeof v === 'string') {
		const n = Date.parse(v)
		if (Number.isFinite(n)) return n
	}
	return 0
}

// 把当天的轮次压到 limit 以内：首 25% 全取、尾 25% 全取，中间 50% 按间隔
// 均匀抽。中间那一段不能连续取——话题转折往往就在中段，连续取 26 条等于只看
// 当天某几个小时；按 step 跳着取，才能保住「这一天怎么演变的」这条主线。
// 不足 limit 的全量送，不抽样：抽了反而丢事实，而且这种会话本来就不贵。
function sampleRounds(rounds, limit) {
	const list = Array.isArray(rounds) ? rounds : []
	const cap = clampInt(limit, 1, 1000, DEFAULT_SETTINGS.roundsPerSession)
	if (list.length <= cap) return list
	const headN = Math.floor(cap * ROUND_HEAD_PCT)
	const tailN = Math.floor(cap * ROUND_TAIL_PCT)
	const midN = cap - headN - tailN
	const midCount = list.length - headN - tailN
	const out = list.slice(0, headN)
	if (midN > 0 && midCount > 0) {
		// step >= 1，floor(i * step) 必然单调递增：既不会取到重复项，也不会连片
		const step = midCount / midN
		for (let i = 0; i < midN; i += 1) out.push(list[headN + Math.floor(i * step)])
	}
	for (let i = list.length - tailN; i < list.length; i += 1) out.push(list[i])
	return out
}

// 取该模型支持的最低思考档位。摘要这种活不需要长思考，而思考 token 常常比
// 正文还贵。efforts 按「从低到高」排序，取第一个；模型不暴露 reasoning
// 信息（非推理模型）就返回 null，调用方不传这个字段，让适配器用自己默认。
async function lowestReasoningEffort(llm, provider, model) {
	if (typeof llm.resolveModelInfo !== 'function') return null
	try {
		const info = await llm.resolveModelInfo(provider, model)
		const efforts = info && info.reasoning && info.reasoning.efforts
		if (Array.isArray(efforts) && efforts.length > 0 && efforts[0] && typeof efforts[0].id === 'string') {
			return efforts[0].id
		}
	} catch (e) {
		console.error(LOG, 'resolveModelInfo failed, 用默认思考档位:', (e && e.message) || String(e))
	}
	return null
}

function baseName(p) {
	if (typeof p !== 'string' || p === '') return ''
	const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
	return parts.length > 0 ? parts[parts.length - 1] : ''
}

// 校验并解析 YYYY-MM-DD（必须是真实存在的本地日期）
function parseDateStr(input) {
	if (typeof input !== 'string' || input === '') return null
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
	if (!m) throw new Error('日期格式应为 YYYY-MM-DD')
	const y = parseInt(m[1], 10)
	const mo = parseInt(m[2], 10)
	const d = parseInt(m[3], 10)
	const probe = new Date(y, mo - 1, d)
	if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
		throw new Error('日期不存在：' + input)
	}
	return { y, m: mo, d }
}

function resolveDate(input) {
	const parsed = parseDateStr(input)
	if (!parsed) return localDateStr(new Date())
	return input
}

function dayBounds(dateStr) {
	const parsed = parseDateStr(dateStr)
	const now = Date.now()
	let from
	let endOfDay
	if (parsed) {
		from = new Date(parsed.y, parsed.m - 1, parsed.d, 0, 0, 0, 0).getTime()
		endOfDay = new Date(parsed.y, parsed.m - 1, parsed.d + 1, 0, 0, 0, 0).getTime() - 1
	} else {
		const d = new Date()
		from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
		endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime() - 1
	}
	return { from, to: Math.min(endOfDay, now) }
}

async function mapLimit(items, limit, fn) {
	const list = Array.isArray(items) ? items : []
	const out = new Array(list.length)
	let cursor = 0
	const worker = async () => {
		while (cursor < list.length) {
			const i = cursor
			cursor += 1
			out[i] = await fn(list[i], i)
		}
	}
	const n = Math.max(1, Math.min(limit, list.length || 1))
	const workers = []
	for (let i = 0; i < n; i += 1) workers.push(worker())
	await Promise.all(workers)
	return out
}

function textOfContent(content, max) {
	if (!Array.isArray(content)) return ''
	const parts = []
	for (const block of content) {
		if (!block || typeof block !== 'object') continue
		if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
			parts.push(block.text.trim())
		}
	}
	return truncate(parts.join('\n'), max)
}

// 一条 assistant/message 事件里「给用户的结论」。
// 正文不在 data.content（那是 user/message 的路径），在 data.message.content；
// 它是块数组，同时含 reasoning（内部推理）和 text（结论）两种块，只有后者是
// 给用户看的：把推理塞进摘要等于让模型以为「想过」就是「做过」。
// 块筛选规则复用 textOfContent，不让两处判据分叉。
function assistantTextOf(ev) {
	const data = ev && ev.data
	const message = data && data.message
	return textOfContent(message && message.content, ROUND_RAW_MAX)
}

// 一个会话的 digest 段，压成「一轮两行」：### 头给标题、- 行给当天的时间跨度
// 与轮次规模，正文只剩「用户: 」「AI: 」两种前缀。
//
// 为什么不再分「开头 / 主线 / 结果 / 结尾」：那套结构是从几百轮里挑三四条，
// 挑得再准也答不上「中间做了什么」；现在每轮留一点，让写日记的模型按时间
// 顺序自己读，比在本地替它判断「哪一条重要」可靠得多。
function buildDigest(item, preset, roundsLimit) {
	const lines = []
	const tag = item.origin === 'subagent' ? '（子代理会话）' : ''
	// 标题也可能是整段代码（DSH 用首条诉求自动起标题），这种标题对分组毫无帮助，
	// 退回项目名，别让 digest 的 ### 头变成一坨代码
	const title = isNoiseTitle(item.title) ? '' : (item.title || '')
	lines.push('### ' + (title || item.project || item.id) + tag)
	const all = Array.isArray(item.rounds) ? item.rounds : []
	const picked = sampleRounds(all, roundsLimit)
	// 会话头压成一行：当天的时间跨度 + 轮次规模。抽样比要报出来，否则模型会把
	// 「只看到 50 轮」读成「这天只做了 50 轮」，把没送出去的中间段当成空白。
	let meta = hmRange(item.firstAt, item.lastAt) + ' · ' + all.length + ' 轮'
	if (picked.length < all.length) meta += '（抽 ' + picked.length + ' 轮）'
	lines.push('- ' + meta)
	// brief 档不送 cwd：项目分组头已经给了目录，长路径对「做了什么」没有信息量
	if (preset.keepCwd) lines.push('- 目录: ' + (item.cwd || '未知'))
	for (const r of picked) {
		// 客套 / 追问 / 粘贴物不占「用户: 」这一行，但这一轮不丢：AI 结论照样送，
		// 「继续」之后那条结论往往正是这一轮的实际产出。
		const user = isNoisePrompt(r.user) ? '' : truncate(r.user, ROUND_USER_CHARS)
		if (user !== '') lines.push('用户: ' + user)
		if (typeof r.ai === 'string' && r.ai !== '') lines.push('AI: ' + truncate(r.ai, ROUND_AI_CHARS))
	}
	return lines.join('\n')
}

// 按 cwd 分项目：同一目录下的不同会话属于同一个项目，key 用目录，project 只是
// 展示用的 basename。
function groupByProject(items) {
	const map = new Map()
	for (const item of items) {
		const key = item.cwd || item.project || '未知目录'
		if (!map.has(key)) map.set(key, { key, project: item.project || '未命名项目', sessions: [] })
		map.get(key).sessions.push(item)
	}
	return Array.from(map.values())
}

function buildProjectSection(group, preset, roundsLimit) {
	const out = [preset.keepCwd ? ('## 项目: ' + group.project + ' (' + group.key + ')') : ('## ' + group.project)]
	for (const item of group.sessions) out.push(buildDigest(item, preset, roundsLimit))
	return out.join('\n\n')
}

function buildDigestText(items, preset, roundsLimit) {
	return groupByProject(items).map((g) => buildProjectSection(g, preset, roundsLimit)).join('\n\n')
}

// 分项目生成期间的过渡正文：让人看到「已经写完哪几个项目」，也说清这不是最终
// 结果。合并请求一开始它就会被真正的日记正文覆盖。
function draftProgressText(groups, drafts, done) {
	const parts = ['正在分项目生成（' + done + '/' + groups.length + '）…', '']
	for (let i = 0; i < groups.length; i += 1) {
		if (drafts[i] === '') continue
		parts.push('## ' + groups[i].project)
		parts.push(drafts[i])
		parts.push('')
	}
	return parts.join('\n')
}

// 提示词里必须明确禁止思考过程。2026-10-28 受控实测（同一 digest、同一模型
// eccom/Eccom-Coder、brief 档）：带这条指令 3/3 次都出了正文，不带的那次
// 思考飙到 9052 字、把 maxTokens 吃光导致 content=0。网关不转发
// reasoning_effort / enable_thinking / thinking.type（六种关思考写法实测一个
// 都没真关），提示词是唯一还能影响思考长度的抓手，虽然压不到零。
function buildPrompt(dateStr, digestText, language, preset) {
	const limit = '总长不超过 ' + preset.maxChars + ' 字'
	if (language === 'en') {
		const openItems = preset.openItems
			? '\n## Open items and next steps\nUnfinished work, unresolved errors, obvious next steps.\n'
			: ''
		return 'Below are the conversation rounds of every DSH session that was active on ' + dateStr + ', grouped by project (two lines per round: the user request and the AI conclusion of that round).\n' +
			'Write a daily work summary in English, in Markdown, with exactly these sections:\n' +
			'## Overview\nOne paragraph (max 100 words) on what the day was about.\n\n' +
			'## Work by project\nGroup by project; each project gets 2 to 4 concrete items (what changed, what was investigated, what conclusion was reached). Keep each item to one or two sentences; do not expand technical detail.\n'
			+ openItems + '\n' +
			'Rules: use bullet points; ' + limit + '; rely only on the digest below, never invent facts; output the diary body only, with no thinking, analysis or draft process and no extra commentary.\n\n===== SESSION DIGEST =====\n' + digestText
	}
	const openItems = preset.openItems
		? '\n## 遗留与下一步\n未完成的事、报错未解决的、明显的下一步。\n'
		: ''
	return '以下是 ' + dateStr + ' 这一天所有有活动的 DSH 会话记录（按项目分组，每轮两行：用户诉求 + 该轮的 AI 结论）。\n' +
		'请只依据这些记录，用中文写一份当天的日记（Markdown 格式），固定包含这些节：\n' +
		'## 今日概览\n一段话（不超过 100 字）说明今天整体在忙什么。\n\n' +
		'## 按项目列出今天做了哪些工作\n按项目分组，每个项目 2 到 4 条具体事项（改了什么、排查了什么、结论是什么），每条一两句话，不要展开技术细节。\n'
		+ openItems + '\n' +
		'要求：条目化；' + limit + '；只依据下面的会话记录，不要编造；直接输出日记正文，不要输出思考、分析或草稿过程，也不要额外说明。\n\n===== 会话记录 =====\n' + digestText
}

// 单个项目的请求。只写这一段、不带总览和遗留：整份日记塞不下当天的全部轮次，
// 拆成「一项目一次请求」之后每次请求都能聚焦在一条工作线上，指令也可以更窄。
// 明确禁止写标题，返回的正文就是可以直接拼进合并输入的项目段落。
function buildProjectPrompt(dateStr, group, digestText, language, preset) {
	const limit = '不超过 ' + preset.sectionChars + ' 字'
	if (language === 'en') {
		return 'Below are the conversation rounds recorded on ' + dateStr + ' inside one project (' + group.project + ').\n' +
			'Write the "what got done" part for this project only, in English, as a Markdown bullet list: 2 to 4 concrete items (what changed, what was investigated, what conclusion was reached). One or two sentences per item; do not expand technical detail.\n' +
			'Rules: ' + limit + '; rely only on the rounds below, never invent facts; no heading, no overview, no next-step section; output the bullet list only, with no thinking, analysis or draft process and no extra commentary.\n\n===== PROJECT ROUNDS =====\n' + digestText
	}
	return '以下是 ' + dateStr + ' 这一天在项目「' + group.project + '」里的会话轮次记录。\n' +
		'请只针对这一个项目，用中文写当天做了哪些工作（Markdown 列表）：2 到 4 条具体事项（改了什么、排查了什么、结论是什么），每条一两句话，不要展开技术细节。\n' +
		'要求：' + limit + '；只依据下面的记录，不要编造；不要写标题、不要写今日概览、不要写遗留与下一步；只输出列表正文，不要输出思考、分析或草稿过程，也不要额外说明。\n\n===== 项目轮次 =====\n' + digestText
}

// 合并请求：各项目段落的顺序、事实都不许动，模型的活只是补一节总览、去掉重复、
// 把跨项目的关联说清楚。要求它「只整理不改写」是有原因的：分段结果已经是当天
// 最准的事实，合并时重新创作一回，等于把两次生成的口径拼在一起。
function buildMergePrompt(dateStr, sections, language, preset) {
	const body = sections.map((s) => '### ' + s.project + '\n' + s.text).join('\n\n')
	const limit = '总长不超过 ' + preset.maxChars + ' 字'
	if (language === 'en') {
		const openItems = preset.openItems
			? '\n## Open items and next steps\nUnfinished work, unresolved errors, obvious next steps.\n'
			: ''
		return 'Below are the per-project sections of the work done on ' + dateStr + ', already written one project at a time.\n' +
			'Merge them into one daily diary in English, in Markdown, with exactly these sections:\n' +
			'## Overview\nOne paragraph (max 100 words) on what the day was about.\n\n' +
			'## Work by project\nKeep every project section; you may reorder sentences, drop duplicates and mention links between projects, but do not add facts that are not in the input.\n'
			+ openItems + '\n' +
			'Rules: use bullet points; ' + limit + '; rely only on the sections below, never invent facts; output the diary body only, with no thinking, analysis or draft process and no extra commentary.\n\n===== PROJECT SECTIONS =====\n' + body
	}
	const openItems = preset.openItems
		? '\n## 遗留与下一步\n未完成的事、报错未解决的、明显的下一步。\n'
		: ''
	return '以下是 ' + dateStr + ' 这一天的工作记录，已经按项目一段一段写好了。\n' +
		'请把它们整理成一份完整的当日日记（Markdown 格式），固定包含这些节：\n' +
		'## 今日概览\n一段话（不超过 100 字）说明今天整体在忙什么。\n\n' +
		'## 按项目列出今天做了哪些工作\n保留每个项目的段落，可以顺句、去重、补上项目之间的关联，但不要添加下面没有的事实。\n'
		+ openItems + '\n' +
		'要求：条目化；' + limit + '；只依据下面的各项目段落，不要编造；直接输出日记正文，不要输出思考、分析或草稿过程，也不要额外说明。\n\n===== 各项目段落 =====\n' + body
}

// ---------- 消费模型流 ----------
// llm.stream 的 finish 分片带的是 reason 对象（契约见 @deepseek-ai/dsh-llm）：
//   { kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error', failure? }
// 旧代码把 reason 整个当字符串存进 run.finishReason，落盘 JSON 变成对象、前端
// typeof === 'string' 判断又把它丢成空串；失败时也从不读 failure，真实原因
// （上游 502 / DNS 解析失败之类）被统一的「模型没有返回内容」盖掉。
const FINISH_KIND_TEXT = {
	stop: 'stop',
	'max-tokens': 'max-tokens',
	'tool-calls': 'tool-calls',
	aborted: 'aborted',
	error: 'error',
}

// 结束原因归一成字符串：落盘（last-runs.json）和前端都要字符串。
// kind 认得就按 kind 给；认不出（reason 不是对象、kind 是未知值）就退回旧的
// 兼容取值链，且只接受字符串——取不到给 null，绝不把对象漏出去。
function finishReasonText(chunk) {
	const reason = chunk && typeof chunk === 'object' ? chunk.reason : null
	if (reason && typeof reason === 'object' && typeof reason.kind === 'string') {
		const mapped = FINISH_KIND_TEXT[reason.kind]
		if (mapped !== undefined) return mapped
	}
	const candidates = [chunk && chunk.finishReason, reason, chunk && chunk.stopReason]
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim() !== '') return c
	}
	return null
}

// 失败信息拼成一句给人看的话：前端会显示成「失败：<message>」，所以带上
// failure.code 和 failure.message，别塞对象也别塞 JSON。
function failureText(kind, failure) {
	const label = kind === 'aborted' ? '模型调用被中断' : '模型调用出错'
	const code = failure && typeof failure.code === 'string' ? failure.code.trim() : ''
	const message = failure && typeof failure.message === 'string' ? failure.message.trim() : ''
	if (code !== '' && message !== '') return label + '：' + code + ' - ' + message
	if (code !== '') return label + '：' + code
	if (message !== '') return label + '：' + message
	return label + '：上游未提供具体原因'
}

// 消费 llm.stream：正文与思考写进 run，结束原因写成字符串。
// 抛错两档，顺序不能变：
//   1) finish.kind 是 error / aborted —— 立刻抛真实原因（code + message），
//      不再往下走到空正文判断，否则真实原因会被通用那句盖掉；
//   2) 流正常结束（stop / max-tokens / tool-calls）但正文为空 —— 「模型没有返回内容」。
// 单独导出只为单测能直接喂假流，插件对外仍只有 default 的 apply。
export async function consumeStream(stream, run) {
	for await (const chunk of stream) {
		if (!chunk || typeof chunk.type !== 'string') continue
		if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
			run.text += chunk.text
		} else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
			run.reasoning += chunk.text
			if (run.reasoning.length > 20000) run.reasoning = run.reasoning.slice(-20000)
		} else if (chunk.type === 'finish') {
			run.finishReason = finishReasonText(chunk)
			const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : null
			if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
				throw new Error(failureText(reason.kind, reason.failure))
			}
			break
		}
	}
	// 只有流正常结束（stop / max-tokens / tool-calls）却一个字都没有时，才说
	// 「没有返回内容」——真正的失败原因在上面已经抛掉了。
	if (run.text.trim() === '') throw new Error('模型没有返回内容')
}

function settingsPatchTimeToMs(timeStr) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(typeof timeStr === 'string' ? timeStr : '')
	if (!m) return { h: 18, mi: 0 }
	return { h: parseInt(m[1], 10), mi: parseInt(m[2], 10) }
}

function msUntilNextRun(timeStr, from) {
	const { h, mi } = settingsPatchTimeToMs(timeStr)
	const now = from || new Date()
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0)
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
	return next.getTime() - now.getTime()
}

function passedToday(timeStr, now) {
	const { h, mi } = settingsPatchTimeToMs(timeStr)
	const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0)
	return now.getTime() >= target.getTime()
}

export default {
	apply(ctx) {
		let settings = loadSettings()

		// date -> run；同一天只保留一条，避免重复生成
		const runs = new Map()
		// 读会话不便宜（每个候选一次全量日志读，今天这种量级约 6s）：
		// 同一天的并发收集合并成一次；过去日期的结果不会再变，缓存复用；
		// 当天的只信 COLLECT_TTL_MS，之后重读——5 分钟足够盖住「反复开关面板」，
		// 又不会让用户看到太旧的清单。面板 collect 与生成时的 collect 因此能共享扫描。
		const COLLECT_TTL_MS = 300000
		const collectInflight = new Map()
		const collectCache = new Map()

		function collectOnce(get, dateStr) {
			const isToday = dateStr === localDateStr(new Date())
			const cached = collectCache.get(dateStr)
			if (cached !== undefined && (!isToday || Date.now() - cached.at < COLLECT_TTL_MS)) return cached.promise
			const running = collectInflight.get(dateStr)
			if (running !== undefined) return running
			const promise = collectSessions(get, dateStr).then(
				(value) => {
					collectInflight.delete(dateStr)
					collectCache.set(dateStr, { at: Date.now(), promise: Promise.resolve(value) })
					return value
				},
				(e) => {
					collectInflight.delete(dateStr)
					throw e
				},
			)
			collectInflight.set(dateStr, promise)
			return promise
		}
		// 定时器状态：get 是拿到 sessionQuery / llm 的上下文
		const sched = { timer: null, get: null }
		let caughtUp = false

		function loadSavedRuns() {
			const raw = readJson(lastRunsFile())
			return Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object' && typeof e.date === 'string') : []
		}

		function findSavedRun(dateStr) {
			const found = loadSavedRuns().find((e) => e.date === dateStr)
			if (!found || typeof found.text !== 'string') return null
			return {
				date: found.date,
				mode: found.mode === 'auto' ? 'auto' : 'manual',
				startedAt: typeof found.startedAt === 'number' ? found.startedAt : 0,
				finishedAt: typeof found.finishedAt === 'number' ? found.finishedAt : 0,
				text: found.text,
				// 落盘的结束原因：撞上 maxTokens 被截断的总结，重开面板时也得继续
				// 标出来，不能只在新生成的那一次提示、刷新一下警告就消失了
				finishReason: typeof found.finishReason === 'string' ? found.finishReason : '',
			}
		}

		function persistRun(run) {
			const list = loadSavedRuns().filter((e) => e.date !== run.date)
			list.push({
				date: run.date,
				mode: run.mode,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt || Date.now(),
				text: run.text,
				sessions: run.sessions,
				finishReason: run.finishReason,
			})
			list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
			writeJson(lastRunsFile(), list.slice(0, MAX_SAVED_RUNS))
		}

		// ---------- 读会话 ----------
		// 「当天做了哪些工作」= 当天有活动的会话，不是当天创建的会话。
		// 实测（2026-10-26）：当天有活动的 14 个会话里只有 3 个是当天创建的，
		// 按创建时间筛会漏掉四分之三，跨天继续干活的长会话全丢。
		//
		// 成本事实：sessionQuery 的每次读（listEvents / readEvent / readSession）
		// 都是全量加载会话日志，观测缓存只有 5 条 LRU。所以每个会话只读一次——
		// 一次 readSession 同时拿出 header（createdAt / cwd / origin）、最后事件
		// 时间、标题（session/title 事件 last-wins）、消息与工具计数、最早和最晚
		// 的用户诉求正文。旧的 listEvents + readTitleSnapshots + 4×readEvent 组合
		// 每个会话要读 6 次，11 个会话实测 10.7s。
		//
		// 候选集合 = 两路便宜信号取并集，再用 readSession 的真实事件时间终审：
		//   1) sessionController.list() 的 updatedAt（最近一次真人提问，取自持久化
		//      投影缓存）——但投影缓存不是全覆盖，漏掉的会话 updatedAt 退回 createdAt；
		//   2) 最近 RECENT_DAYS 天创建的会话——把第 1 路漏掉的补回来。
		// 第 2 路是纯追加：猜错只会多读几个会话，绝不会漏。
		const RECENT_DAYS = 7
		const READ_CONCURRENCY = 3

		function projectionTitle(item) {
			const values = item && item.projections && item.projections.values
			const t = values && values.title
			return typeof t === 'string' && t.trim() !== '' ? t.trim() : ''
		}

		async function controllerItems(get) {
			const controller = get('sessionController')
			if (!controller || typeof controller.list !== 'function') return []
			try {
				const res = await controller.list({})
				return (res && Array.isArray(res.items)) ? res.items : []
			} catch (e) {
				console.error(LOG, 'sessionController.list failed:', (e && e.message) || String(e))
				return []
			}
		}

		async function recentRecords(sessionQuery, from) {
			try {
				const records = await sessionQuery.filterSessions([{ kind: 'created-at', from }])
				if (Array.isArray(records)) return records
			} catch (e) {
				console.error(LOG, 'filterSessions failed, fallback to listSessions:', (e && e.message) || String(e))
			}
			try {
				const records = await sessionQuery.listSessions()
				return Array.isArray(records) ? records : []
			} catch (e) {
				console.error(LOG, 'listSessions failed:', (e && e.message) || String(e))
				return []
			}
		}

		// 候选集合 = 两路便宜信号取并集，再用 readSession 的真实事件时间终审：
		// sessionController.list() 的 updatedAt 命中当天的，加上最近 7 天创建的。
		// updatedAt 取自持久化投影缓存、不是全覆盖，缓存没覆盖的会话会退回 createdAt
		// 而被漏掉，第二路就是补这个漏；最后用 readSession 的真实事件时间终审，
		// 第二路纯追加，猜错只会多读几个会话，不会漏。
		//
		// 关键拆分：这一步一次日志都不读（约 0.5s），足够渲染明细卡片；
		// 计数与用户诉求正文只有生成 digest 时才要，那才值得付全量读取的代价。
		async function listCandidates(get, sessionQuery, dateStr) {
			const bounds = dayBounds(dateStr)
			const recentFrom = bounds.from - RECENT_DAYS * 86400000

			const [items, records] = await Promise.all([
				controllerItems(get),
				recentRecords(sessionQuery, recentFrom),
			])

			const byId = new Map()
			for (const item of items) {
				if (!item || typeof item.sessionId !== 'string') continue
				if (item.blank === true) continue
				const lastAt = toMs(item.updatedAt)
				if (lastAt < bounds.from || lastAt > bounds.to) continue
				// updatedAt 就是当天，日期已确认
				byId.set(item.sessionId, {
					id: item.sessionId,
					cwd: typeof item.cwd === 'string' ? item.cwd : '',
					createdAt: 0,
					lastAt,
					origin: item.origin === 'subagent' ? 'subagent' : '',
					title: projectionTitle(item),
					confirmed: true,
				})
			}
			for (const record of records) {
				const header = record && record.header
				if (!header || typeof header.id !== 'string') continue
				if (byId.has(header.id)) continue
				const createdAt = toMs(header.createdAt)
				if (createdAt < recentFrom) continue
				// 只有 header，没有 updatedAt：创建时间落在当天才算日期已确认；
				// 否则只是"最近 7 天创建"，当天是否活动未知，标未确认
				const confirmed = createdAt >= bounds.from && createdAt <= bounds.to
				byId.set(header.id, {
					id: header.id,
					cwd: typeof header.cwd === 'string' ? header.cwd : '',
					createdAt,
					lastAt: createdAt,
					origin: header.origin === 'subagent' ? 'subagent' : '',
					title: '',
					confirmed,
				})
			}
			return { bounds, candidates: Array.from(byId.values()) }
		}

		async function collectSessions(get, dateStr) {
			const sessionQuery = get('sessionQuery')
			if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
				throw new Error('sessionQuery 服务不可用')
			}
			const startedAt = Date.now()
			const { bounds, candidates } = await listCandidates(get, sessionQuery, dateStr)

			const probed = await mapLimit(candidates, READ_CONCURRENCY, async (cand) => {
				try {
					return await buildSessionItem(sessionQuery, cand, bounds)
				} catch (e) {
					console.error(LOG, 'session skipped:', cand.id, (e && e.message) || String(e))
					return null
				}
			})

			// 终审：只要当天真的有轮次的。buildSessionItem 已经按 bounds 切过事件，
			// 返回 null 的就是当天没干活；投影缓存过期而漏掉的会话靠这一步捞回来
			const active = probed
				.filter((x) => x !== null)
				.sort((a, b) => b.lastAt - a.lastAt)

			const cap = settings.maxSessions
			const picked = active.slice(0, cap)
			const truncated = Math.max(0, active.length - picked.length)
			console.log(LOG, 'collect', dateStr,
				'candidates=' + candidates.length,
				'active=' + active.length,
				'kept=' + picked.length,
				'dropped=' + (candidates.length - active.length),
				'ms=' + (Date.now() - startedAt))
			return { sessions: picked, truncated }
		}

		// 便宜的那一路：不读任何日志，只凭 sessionController.list() 与 filterSessions
		// 的 header。字段和 collect 一致，但计数与诉求正文未知，用 partial 标记，
		// 前端对这些字段显示占位。collect 完成后由完整数据替换。
		async function listCheap(get, dateStr) {
			const sessionQuery = get('sessionQuery')
			if (!sessionQuery) throw new Error('sessionQuery 服务不可用')
			const startedAt = Date.now()
			const { bounds, candidates } = await listCandidates(get, sessionQuery, dateStr)

			// 便宜路径没有 readSession 终审，所以只认日期已确认的候选；
			// 未确认的（最近 7 天创建但当天是否活动未知）等 collect 的完整结果补上。
			// 结论：便宜列表可能少几个跨天会话，但不会多，随后被完整数据修正。
			const rows = candidates
				.filter((cand) => cand.confirmed === true)
				.map((cand) => {
					const cwd = cand.cwd
					const project = baseName(cwd) || '未命名项目'
					return {
						id: cand.id,
						title: cand.title || project || cand.id.slice(0, 8),
						cwd,
						project,
						origin: cand.origin,
						createdAt: cand.createdAt,
						firstAt: cand.createdAt,
						lastAt: cand.lastAt,
						userMsgs: 0,
						assistantMsgs: 0,
						toolCalls: 0,
						// 卡片只显示首条诉求这一行，便宜路径拿不到，留空由 partial 占位
						firstPrompts: [],
						rounds: [],
						partial: true,
					}
				})
				.sort((a, b) => b.lastAt - a.lastAt)

			const cap = settings.maxSessions
			const picked = rows.slice(0, cap)
			const truncated = Math.max(0, rows.length - picked.length)
			console.log(LOG, 'list', dateStr,
				'candidates=' + candidates.length,
				'kept=' + picked.length,
				'ms=' + (Date.now() - startedAt))
			return { sessions: picked, truncated }
		}

		// 一次 readSession 拿全：header、标题、计数、当天的轮次。
		//
		// 一个会话往往跨好几天，而 diary 只写「目标日期这一天」，所以事件必须先
		// 按 [from, 00:00 次日) 切一遍再切成轮次。这一步之前漏做，导致跨天会话里
		// 前几天的结论被当成今天的产出写进日记。
		//
		// 「轮次」= 一条真人输入 + 它之后到下一条真人输入之前的那条 AI 最终回复。
		// 判据是「后面不紧跟 tool/call」：DSH 一轮里会连着产生好几条
		// assistant/message（每条后面跟一批工具调用），那些是内部过程，占了日志
		// 九成的体积，进摘要只会把真正的结论挤掉。判据放在按天过滤后的序列上——
		// 跨天会话在当天末尾的那条助手消息，本来就该算当天的结论。
		async function buildSessionItem(sessionQuery, cand, bounds) {
			const snap = await sessionQuery.readSession(cand.id)
			const header = (snap && snap.session) || null
			const events = (snap && Array.isArray(snap.events)) ? snap.events : []
			const createdAt = toMs(header && header.createdAt) || cand.lastAt
			const cwd = (header && typeof header.cwd === 'string' && header.cwd !== '') ? header.cwd : cand.cwd
			const project = baseName(cwd) || '未命名项目'

			let title = ''
			let assistantMsgs = 0
			let toolCalls = 0
			let firstAt = 0
			let lastAt = 0
			const dayEvents = []
			for (const ev of events) {
				if (!ev || typeof ev.type !== 'string') continue
				if (ev.type === 'session/title') {
					// 标题折叠规则就是 last-wins，与官方 title 投影一致。
					// 标题可能是在别的日期设的，不参与按天过滤。
					const text = ev.data && ev.data.title
					if (typeof text === 'string' && text.trim() !== '') title = text.trim()
					continue
				}
				const t = toMs(ev.time)
				if (t < bounds.from || t > bounds.to) continue
				dayEvents.push(ev)
				if (firstAt === 0 || t < firstAt) firstAt = t
				if (t > lastAt) lastAt = t
				if (ev.type === 'assistant/message') assistantMsgs += 1
				else if (ev.type === 'tool/call') toolCalls += 1
			}

			const rounds = []
			let cur = null
			for (let i = 0; i < dayEvents.length; i += 1) {
				const ev = dayEvents[i]
				if (ev.type === 'user/message') {
					const data = ev.data || {}
					const source = data.source
					// 只有 source.kind === 'user' 才是真人输入，其余是 agent.inject
					// 合成的上下文
					if (!source || source.kind !== 'user') continue
					cur = { user: textOfContent(data.content, ROUND_RAW_MAX), ai: '' }
					rounds.push(cur)
				} else if (ev.type === 'assistant/message') {
					const next = dayEvents[i + 1]
					if (next && next.type === 'tool/call') continue
					if (cur === null) continue
					// 同一轮里若还剩多条收尾结论，后一条覆盖前一条：越靠后越接近落点
					cur.ai = assistantTextOf(ev)
				}
			}
			// 当天没有事件、或没有一条真人输入：这个会话对今天的日记没有信息量
			if (rounds.length === 0) return null

			return {
				id: cand.id,
				title: cand.title || title || project || cand.id.slice(0, 8),
				cwd,
				project,
				origin: cand.origin,
				createdAt,
				// 当天的活跃区间，digest 头用它报时间跨度。createdAt 是会话创建时间，
				// 跨天会话拿它报时间会显示成「10-23 到 10-26」，读不出今天几点在干活。
				firstAt,
				lastAt,
				userMsgs: rounds.length,
				assistantMsgs,
				toolCalls,
				rounds,
				// 面板卡片只显示「首条诉求」一行；rounds 是几十 KB 的正文，不进
				// collect / poll 的响应（见 collect 路由里的 briefOf）。
				firstPrompts: rounds[0].user !== '' ? [rounds[0].user] : [],
			}
		}

		// ---------- 生成 ----------
		function resolveModel(get) {
			let provider = settings.provider
			let model = settings.model
			if (!provider || !model) {
				try {
					const adm = get('agentDefaultModel')
					const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
					if (sel && typeof sel === 'object') {
						if (!provider && typeof sel.provider === 'string') provider = sel.provider
						if (!model && typeof sel.model === 'string') model = sel.model
					}
				} catch (e) { /* ignore */ }
			}
			if (!provider || !model) return null
			return { provider, model }
		}

		// 回给前端的会话摘要。rounds 必须在这里切掉：一天的轮次正文有几十 KB，
		// 塞进 collect / poll 的响应既拖慢首屏，也是纯装饰（卡片只显示首条诉求）。
		function briefOf(item) {
			return {
				id: item.id,
				title: item.title,
				cwd: item.cwd,
				project: item.project,
				origin: item.origin,
				createdAt: item.createdAt,
				lastAt: item.lastAt,
				userMsgs: item.userMsgs,
				assistantMsgs: item.assistantMsgs,
				toolCalls: item.toolCalls,
				firstPrompts: item.firstPrompts,
			}
		}

		async function pump(get, run) {
			try {
				const collected = await collectOnce(get, run.date)
				run.sessions = collected.sessions.map(briefOf)
				run.truncated = collected.truncated
				if (collected.sessions.length === 0) {
					run.text = EMPTY_TEXT
					run.done = true
					run.finishedAt = Date.now()
					persistRun(run)
					return
				}
				const llm = get('llm')
				if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')
				const selected = resolveModel(get)
				if (!selected) throw new Error('无法确定用于总结的模型，请在设置里指定 provider 与 model')

				const preset = VERBOSITY_PRESETS[settings.verbosity] || VERBOSITY_PRESETS.brief
				const roundsLimit = settings.roundsPerSession

				// maxTokens 与思考档位的取法，2026-10-28 实测后改过一轮：
				// maxTokens 必须同时装下思考与正文。原先按「字数要求留一倍余量」
				// 给 900/1600，结果八个参测模型全部 finish=length、content=0——
				// 思考长度在 1500-6600 字之间波动，额度在吐正文前就被吃光。
				// 现在按思考上界给 4000/6000，字数约束仍靠提示词（实测基本服管）。
				// reasoningEffort 只能「锦上添花」：模型暴露档位时才压到最低，
				// 网关不转发这个字段，别指望它关掉思考（详见 VERBOSITY_PRESETS 注释）。
				const effort = await lowestReasoningEffort(llm, selected.provider, selected.model)
				// 每次请求单独建 options：分段请求的提示词不同，共用一个对象迟早
				// 会有一处忘了换 messages
				const makeOptions = (promptText) => {
					const options = {
						provider: selected.provider,
						model: selected.model,
						messages: [{
							id: 'msg-' + run.runId,
							role: 'user',
							content: [{ type: 'text', text: promptText }],
							source: { kind: 'user' },
						}],
						maxTokens: preset.maxTokens,
					}
					if (effort !== null) options.reasoningEffort = effort
					return options
				}

				const groups = groupByProject(collected.sessions)
				if (groups.length === 1) {
					// 只有一个项目时退化成一次请求：多拆一步只是多一次思考成本，
					// 分段能带来的聚焦在这里没有对象
					const digestText = buildDigestText(collected.sessions, preset, roundsLimit)
					const promptText = buildPrompt(run.date, digestText, settings.language, preset)
					console.log(LOG, 'generate', run.date, 'provider=' + selected.provider, 'model=' + selected.model,
						'maxTokens=' + preset.maxTokens, 'effort=' + (effort || 'default'),
						'projects=1', 'digestChars=' + digestText.length)
					await consumeStream(llm.stream(makeOptions(promptText)), run)
				} else {
					// 一项目一次请求：当天的轮次放不进一份能写好的摘要，拆开之后
					// 每次请求只面对一条工作线，提示词也能窄到「只写这个项目」；
					// 最后再发一次合并请求，负责今日概览和项目之间的串场。
					const drafts = new Array(groups.length).fill('')
					let done = 0
					await mapLimit(groups, PROJECT_CONCURRENCY, async (group, i) => {
						const digestText = buildProjectSection(group, preset, roundsLimit)
						const promptText = buildProjectPrompt(run.date, group, digestText, settings.language, preset)
						try {
							const scratch = { text: '', reasoning: '', finishReason: null }
							await consumeStream(llm.stream(makeOptions(promptText)), scratch)
							drafts[i] = scratch.text.trim()
						} catch (e) {
							// 单个项目失败不拖垮整份日记：合并阶段还有别的段落可用，
							// 缺的那一块留在日志里由维护者查
							console.error(LOG, 'project failed', run.date, group.project, (e && e.message) || String(e))
						}
						done += 1
						run.text = draftProgressText(groups, drafts, done)
						console.log(LOG, 'project', run.date, group.project, 'done=' + done + '/' + groups.length,
							'chars=' + drafts[i].length)
					})
					const sections = []
					for (let i = 0; i < groups.length; i += 1) {
						if (drafts[i] !== '') sections.push({ project: groups[i].project, text: drafts[i] })
					}
					if (sections.length === 0) throw new Error('所有项目的段落都没有生成出内容')
					// 合并阶段的正文才是最终结果。先清掉过程稿，否则 poll 会把
					// 「正在分项目生成」的草稿当成日记正文显示出来
					run.text = ''
					run.reasoning = ''
					const mergePrompt = buildMergePrompt(run.date, sections, settings.language, preset)
					console.log(LOG, 'merge', run.date, 'projects=' + sections.length,
						'mergeChars=' + mergePrompt.length, 'maxTokens=' + preset.maxTokens)
					await consumeStream(llm.stream(makeOptions(mergePrompt)), run)
				}
				run.done = true
				run.finishedAt = Date.now()
				persistRun(run)
				console.log(LOG, 'finished', run.date, run.mode, 'textLen=' + run.text.length, 'sessions=' + run.sessions.length,
					'projects=' + groups.length, 'finish=' + (run.finishReason || '-'))
			} catch (e) {
				run.error = (e && e.message) ? e.message : String(e)
				run.done = true
				run.finishedAt = Date.now()
				console.error(LOG, 'failed', run.date, run.mode, run.error)
			}
		}

		function trimRuns() {
			if (runs.size <= MAX_RUNS) return
			const list = Array.from(runs.values()).sort((a, b) => a.startedAt - b.startedAt)
			for (const r of list) {
				if (runs.size <= MAX_RUNS) break
				if (r.done) runs.delete(r.date)
			}
			for (const r of list) {
				if (runs.size <= MAX_RUNS) break
				runs.delete(r.date)
			}
		}

		function startRun(get, dateStr, mode) {
			const existing = runs.get(dateStr)
			// 同一日期已有进行中的任务：直接复用，保证 start 幂等
			if (existing && !existing.done) return existing
			const run = {
				runId: 'dsr-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36),
				date: dateStr,
				mode: mode === 'auto' ? 'auto' : 'manual',
				text: '',
				reasoning: '',
				done: false,
				error: null,
				startedAt: Date.now(),
				finishedAt: 0,
				sessions: [],
				truncated: 0,
				// 模型输出的结束原因。'length' = 撞上 maxTokens 被截断，
				// 这时正文可能停在中句，必须让用户知道，不能当完整总结展示
				finishReason: null,
			}
			runs.set(dateStr, run)
			trimRuns()
			run.promise = pump(get, run)
			return run
		}

		// ---------- 定时 ----------
		function clearTimer() {
			if (sched.timer) {
				clearTimeout(sched.timer)
				sched.timer = null
			}
		}

		function armSchedule() {
			clearTimer()
			if (!sched.get) return
			if (!settings.enabled) return
			const delay = Math.max(1000, Math.min(msUntilNextRun(settings.time), 2147483647))
			sched.timer = setTimeout(() => {
				sched.timer = null
				const get = sched.get
				try {
					const run = startRun(get, localDateStr(new Date()), 'auto')
					run.promise.catch(() => { /* pump 内部已记录 */ })
					console.log(LOG, 'scheduled run triggered at', settings.time)
				} catch (e) {
					console.error(LOG, 'scheduled run failed:', (e && e.message) || String(e))
				}
				armSchedule()
			}, delay)
			if (sched.timer && typeof sched.timer.unref === 'function') sched.timer.unref()
		}

		function catchUp(get) {
			if (caughtUp) return
			caughtUp = true
			if (!settings.enabled) return
			const now = new Date()
			if (!passedToday(settings.time, now)) return
			const today = localDateStr(now)
			if (findSavedRun(today)) return
			console.log(LOG, 'catch-up: 今天是 ' + today + '，已过设定时间 ' + settings.time + '，补跑一次日记')
			try {
				const run = startRun(get, today, 'auto')
				run.promise.catch(() => { /* pump 内部已记录 */ })
			} catch (e) {
				console.error(LOG, 'catch-up failed:', (e && e.message) || String(e))
			}
		}

		// ---------- HTTP 路由 ----------
		ctx.inject(['webServer'], (c) => {
			const webServer = c.get('webServer')
			if (webServer === undefined) return
			// 不要直接把 c.get 当函数传出去：cordis 的 get 依赖接收者
			const get = (name) => c.get(name)

			const ops = {
				// 只读落盘的既有总结，不碰会话日志：面板打开时先调它，让用户立刻看到
				// 已生成的总结，不用等 collect 那几秒。
				async saved(args) {
					const date = resolveDate(args && args.date)
					return { date, summary: findSavedRun(date) }
				},

				// 便宜列表：不读日志，约 0.5s，够先把明细卡片渲染出来
				async sessions(args) {
					const date = resolveDate(args && args.date)
					const listed = await listCheap(get, date)
					return { date, sessions: listed.sessions, truncated: listed.truncated, partial: true }
				},

				// 完整收集：每个候选一次全量日志读，用来拿计数与首条诉求，也供生成用。
				// 会话对象里带着当天的全部轮次（生成要用），但不回给前端——briefOf
				// 切掉 rounds，否则一次 collect 会多传几十 KB 的正文
				async collect(args) {
					const date = resolveDate(args && args.date)
					const collected = await collectOnce(get, date)
					return {
						date,
						sessions: collected.sessions.map(briefOf),
						truncated: collected.truncated,
						summary: findSavedRun(date),
					}
				},

				// 立即返回 runId，生成在后台泵
				async start(args) {
					const date = resolveDate(args && args.date)
					const mode = args && args.mode === 'auto' ? 'auto' : 'manual'
					const run = startRun(get, date, mode)
					return { runId: run.runId, date: run.date, mode: run.mode }
				},

				async poll(args) {
					const runId = args && typeof args.runId === 'string' ? args.runId : ''
					let hit = null
					for (const run of runs.values()) {
						if (run.runId === runId) { hit = run; break }
					}
					if (!hit) return { error: '总结任务不存在或已过期' }
					return {
						text: hit.text,
						reasoning: hit.reasoning,
						done: hit.done,
						error: hit.error,
						date: hit.date,
						mode: hit.mode,
						startedAt: hit.startedAt,
						finishedAt: hit.finishedAt || undefined,
						// pump 已经全量读过当天会话，顺手带回来，省得客户端再读一次
						sessions: hit.sessions,
						truncated: hit.truncated,
						finishReason: hit.finishReason,
					}
				},

				'settings.get': async function () {
					return settings
				},

				'settings.set': async function (patch) {
					const next = sanitizeSettings(Object.assign({}, settings, (patch && typeof patch === 'object') ? patch : {}))
					if (!writeJson(settingsFile(), next)) throw new Error('设置写入失败')
					settings = next
					armSchedule()
					return next
				},

				async models() {
					const out = { providers: [], defaultProvider: '', defaultModel: '' }
					try {
						const adm = c.get('agentDefaultModel')
						const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
						if (sel && typeof sel === 'object') {
							if (typeof sel.provider === 'string') out.defaultProvider = sel.provider
							if (typeof sel.model === 'string') out.defaultModel = sel.model
						}
					} catch (e) { /* ignore */ }
					const llm = c.get('llm')
					if (!llm) return out
					let providers = []
					try {
						providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
					} catch (e) {
						console.error(LOG, 'listProviders failed:', (e && e.message) || String(e))
						providers = []
					}
					for (const p of Array.isArray(providers) ? providers : []) {
						const id = typeof p === 'string' ? p
							: (p && typeof p.id === 'string' ? p.id
								: (p && typeof p.provider === 'string' ? p.provider
									: (p && typeof p.name === 'string' ? p.name : '')))
						if (!id) continue
						let models = []
						try {
							const list = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
							models = (Array.isArray(list) ? list : []).map((m) => {
								if (typeof m === 'string') return m
								if (m && typeof m.id === 'string') return m.id
								if (m && typeof m.model === 'string') return m.model
								if (m && typeof m.name === 'string') return m.name
								return ''
							}).filter((m) => m !== '')
						} catch (e) {
							models = []
						}
						out.providers.push({ id, models })
					}
					return out
				},
			}

			const apiHandler = async (req, res) => {
				const send = (code, obj) => {
					try {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
						res.end(JSON.stringify(obj === undefined ? { ok: true } : obj))
					} catch (e) { /* socket gone */ }
				}
				try {
					if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
					const url = String(req.url || '')
					const q = url.indexOf('?')
					const clean = q >= 0 ? url.slice(0, q) : url
					const op = decodeURIComponent(clean.replace(/^\/+/, '').slice(API_PREFIX.length).replace(/^\/+/, ''))
					const fn = ops[op]
					if (!fn) return send(404, { error: 'unknown op: ' + op })
					const body = await readBody(req)
					const result = await fn(body)
					return send(200, result)
				} catch (e) {
					return send(500, { error: String((e && e.message) || e) })
				}
			}

			ctx.effect(
				() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }),
				'dsh-work-diary: api routes',
			)
		})

		ctx.inject(['sessionQuery', 'llm'], (c) => {
			const get = (name) => c.get(name)
			sched.get = get
			ctx.effect(() => {
				armSchedule()
				catchUp(get)
				return () => { clearTimer() }
			}, 'dsh-work-diary: scheduler')
		})
	},
}

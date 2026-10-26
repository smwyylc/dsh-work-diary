// dsh-work-diary - host half (static package)
// 静态包差异：无 harness builtin，用 webServer 前缀路由
//   POST /dsh-work-diary/api/<op>  (op: saved | sessions | collect | start | poll | settings.get | settings.set | models)
// 职责：按天读会话（sessionQuery）-> 组装 digest -> llm.stream 流式生成中文总结
//       -> 内存 run 供前端 poll -> 定时自动执行与启动补跑 -> 设置/结果落盘。
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
}

// 省 token 的两档。默认 brief：每个会话只送「开头 + 结尾」各一条诉求、各截
// 200 字，长会话（40 条以上）另加一条 120 字的「主线」，砍掉 cwd 行——够说清
// 「今天大致做了什么」，实测比 full 档省一半以上输入。full 档送开头/结尾各
// 两条、各 500 字、主线 400 字、保留 cwd。
// 噪声过滤（客套、追问、整段代码）在 pickDigestPrompts 里做完才进这里，所以
// 这里的 head/tail 已经是「有信息量的首尾」，不是原始的首尾。
// keyChars 是「主线」行的上限：它是线索不是引文，比普通诉求截得短。
const VERBOSITY_PRESETS = {
	// maxTokens 是输出硬顶，比字数要求留一倍余量，避免把正文截断在半句
	brief: { headPrompts: 1, tailPrompts: 1, promptChars: 200, keyChars: 120, keepCwd: false, maxChars: 600, maxTokens: 900, openItems: false },
	full: { headPrompts: 2, tailPrompts: 2, promptChars: 500, keyChars: 400, keepCwd: true, maxChars: 800, maxTokens: 1600, openItems: true },
}

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

// 跨天的会话很多（10-26 当天 13 个会话里 7 个是早几天创建、今天继续干的）。
// 两端都只打时分会让「10-23 17:46 到 10-26 17:35」显示成 17:46-17:35，
// 看着像区间倒挂，也会误导模型对时序的判断。与客户端 hmRange 同一套规则。
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

// 会话的首条/末条诉求经常不是「做了什么」，而是客套、追问或整段粘贴的代码表格。
// 把这些原样送进 digest 等于花 token 买噪声，所以先在入口滤一道。
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
// 而 pickDigestPrompts 的「取最长」正好最爱挑它——10-26 实测三个 501 字段的
// 会话，最长的一条全是日志（`email_analysis - INFO - 开始处理请求`、
// `SalesIntegrationError WARNING`、`curl --location --request POST`），
// 没有这条判据时主线行会被日志占掉，白花钱还答不上「做了什么」。
// 中文占比是最好用的判据：真人述求再短也是中文句子，日志和命令几乎纯 ASCII。
// 阈值取 0.25：实测真实述求的中文占比都在 26% 以上，日志/命令/含密码的粘贴
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

// 长会话的判据。10-26 实测 13 个会话：诉求数 40 以上的正好是首尾两眼一蒙
// 的那几个（254 / 165 / 119 / 49 条），首尾加起来答不上「这一大轮在干什么」；
// 40 以下的会话首尾基本够描述。阈值放低会让中等会话也白吃这条线的钱。
const LONG_SESSION_MSGS = 40
// 首尾各多留几条：preset 只取 1 到 2 条，多出来的给 buildDigest 在首尾重叠时
// 「去重后补位」，别让 preset 的条数白丢。
const DIGEST_HEAD_KEEP = 3
const DIGEST_TAIL_KEEP = 3

// 从全部真人诉求里挑对摘要有用的几条。过滤噪声后取首尾若干条，长会话再补一条
// 「最长诉求」——噪声已在 isNoisePrompt 滤干净（客套、追问、代码、粘贴的日志和
// 命令都不算），剩下的最长的通常就是最具体的需求，能回答「这一大轮到底在干什么」，
// 这正是首尾取样最缺的一块。
function pickDigestPrompts(prompts) {
	const all = (Array.isArray(prompts) ? prompts : []).filter((t) => typeof t === 'string' && t.trim() !== '')
	if (all.length === 0) return { head: [], tail: [], key: '' }
	const clean = all.filter((t) => !isNoisePrompt(t))
	// 整场全是噪声时退回原列表，至少保住首尾原样，别把会话摘空了
	const src = clean.length > 0 ? clean : all
	const head = src.slice(0, DIGEST_HEAD_KEEP)
	const tail = src.slice(-DIGEST_TAIL_KEEP)
	let key = ''
	// 判据用过滤前的 all：要量的是「这个会话有多大」，不是「剩几条干净诉求」。
	// 60 条里 40 条是「继续」的会话同样是长会话，首尾照样说不清它在干什么；
	// 反过来用过滤后的条数，噪声越多越容易漏判，正好漏在最需要主线的会话上。
	// 另一层原因：buildSessionItem 的 userMsgs 也是按过滤前的条数报的，同一口径。
	if (all.length >= LONG_SESSION_MSGS) {
		let best = ''
		for (const t of src) {
			if (t.length > best.length) best = t
		}
		if (best !== '' && head.indexOf(best) === -1 && tail.indexOf(best) === -1) key = best
	}
	return { head, tail, key }
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

function buildDigest(item, preset) {
	const lines = []
	const tag = item.origin === 'subagent' ? '（子代理会话）' : ''
	// 标题也可能是整段代码（DSH 用首条诉求自动起标题），这种标题对分组毫无帮助，
	// 退回项目名，别让 digest 的 ### 头变成一坨代码
	const title = isNoiseTitle(item.title) ? '' : (item.title || '')
	lines.push('### ' + (title || item.project || item.id) + tag)
	// 一行摊平时间与规模，比三个中文标签行省三成
	lines.push('- ' + hmRange(item.createdAt, item.lastAt)
		+ ' · 用户' + item.userMsgs + '/助手' + item.assistantMsgs + '/工具' + item.toolCalls)
	// brief 档不送 cwd：项目分组头已经给了目录，长路径对「做了什么」没有信息量
	if (preset.keepCwd) lines.push('- 目录: ' + (item.cwd || '未知'))
	// 逐条截断再进列表：先 join 后截断会让多条诉求共享一份额度，
	// full 档的「首尾各两条、各 500 字」会被压成两条合吃 500 字
	const head = (item.firstPrompts || []).map((t) => truncate(t, preset.promptChars))
	const tail = (item.lastPrompts || []).map((t) => truncate(t, preset.promptChars))
	// 长会话补一条最长诉求，回答「这一大轮到底在干什么」。够不够长由
	// pickDigestPrompts 判定（它数得到样本量），这里只看有没有货：两处各算一遍
	// 阈值，一旦计数口径不同就会把已经挑好的 key 静默丢掉。
	const key = item.keyPrompt ? truncate(item.keyPrompt, preset.keyChars) : ''
	const seen = new Set()
	const push = (label, text) => {
		if (typeof text !== 'string' || text === '' || seen.has(text)) return false
		seen.add(text)
		lines.push('- ' + label + ': ' + text)
		return true
	}
	// firstPrompts / lastPrompts 多留了几条，就是给这里「去重后补位」用的：
	// 首尾有重叠时用后面那条顶上，别让 preset 的条数白丢
	let kept = 0
	for (const t of head) {
		if (kept >= preset.headPrompts) break
		if (push('开头', t)) kept += 1
	}
	// 「主线」是信息密度最高的一条，排在结尾前面：结尾经常只是收尾动作
	push('主线', key)
	kept = 0
	for (let i = tail.length - 1; i >= 0; i -= 1) {
		if (kept >= preset.tailPrompts) break
		if (push('结尾', tail[i])) kept += 1
	}
	return lines.join('\n')
}

function buildDigestText(items, preset) {
	const groups = new Map()
	for (const item of items) {
		const key = item.cwd || item.project || '未知目录'
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key).push(item)
	}
	const out = []
	for (const [key, list] of groups) {
		const project = (list[0] && list[0].project) || '未命名项目'
		out.push(preset.keepCwd ? ('## 项目: ' + project + ' (' + key + ')') : ('## ' + project))
		for (const item of list) out.push(buildDigest(item, preset))
	}
	return out.join('\n\n')
}

function buildPrompt(dateStr, digestText, language, preset) {
	const limit = '总长不超过 ' + preset.maxChars + ' 字'
	if (language === 'en') {
		const openItems = preset.openItems
			? '\n## Open items and next steps\nUnfinished work, unresolved errors, obvious next steps.\n'
			: ''
		return 'Below is the digest of every DSH session that was active on ' + dateStr + ', grouped by project.\n' +
			'Write a daily work summary in English, in Markdown, with exactly these sections:\n' +
			'## Overview\nOne paragraph (max 100 words) on what the day was about.\n\n' +
			'## Work by project\nGroup by project; each project gets 2 to 4 concrete items (what changed, what was investigated, what conclusion was reached). Keep each item to one or two sentences; do not expand technical detail.\n'
			+ openItems + '\n' +
			'Rules: use bullet points; ' + limit + '; rely only on the digest below, never invent facts; output the summary body only, no extra commentary.\n\n===== SESSION DIGEST =====\n' + digestText
	}
	const openItems = preset.openItems
		? '\n## 遗留与下一步\n未完成的事、报错未解决的、明显的下一步。\n'
		: ''
	return '以下是 ' + dateStr + ' 这一天所有有活动的 DSH 会话的摘要记录（按项目分组）。\n' +
		'请只依据这些记录，用中文写一份当天的日记（Markdown 格式），固定包含这些节：\n' +
		'## 今日概览\n一段话（不超过 100 字）说明今天整体在忙什么。\n\n' +
		'## 按项目列出今天做了哪些工作\n按项目分组，每个项目 2 到 4 条具体事项（改了什么、排查了什么、结论是什么），每条一两句话，不要展开技术细节。\n'
		+ openItems + '\n' +
		'要求：条目化；' + limit + '；只依据下面的会话记录，不要编造；直接输出正文，不要额外说明。\n\n===== 会话记录 =====\n' + digestText
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
					return await buildSessionItem(sessionQuery, cand)
				} catch (e) {
					console.error(LOG, 'session skipped:', cand.id, (e && e.message) || String(e))
					return null
				}
			})

			// 终审：只要当天真的有事件的；投影缓存过期而漏掉的会话靠这一步捞回来
			const active = probed
				.filter((x) => x !== null && x.lastAt >= bounds.from && x.lastAt <= bounds.to)
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
						lastAt: cand.lastAt,
						userMsgs: 0,
						assistantMsgs: 0,
						toolCalls: 0,
						firstPrompts: [],
						lastPrompts: [],
						keyPrompt: '',
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

		// 一次 readSession 拿全：header、标题、计数、最早/最晚用户诉求
		async function buildSessionItem(sessionQuery, cand) {
			const snap = await sessionQuery.readSession(cand.id)
			const header = (snap && snap.session) || null
			const events = (snap && Array.isArray(snap.events)) ? snap.events : []
			const createdAt = toMs(header && header.createdAt) || cand.lastAt
			const cwd = (header && typeof header.cwd === 'string' && header.cwd !== '') ? header.cwd : cand.cwd
			const project = baseName(cwd) || '未命名项目'

			let title = ''
			let assistantMsgs = 0
			let toolCalls = 0
			let lastAt = createdAt
			const prompts = []
			for (const ev of events) {
				if (!ev || typeof ev.type !== 'string') continue
				const t = toMs(ev.time)
				if (t > lastAt) lastAt = t
				if (ev.type === 'assistant/message') assistantMsgs += 1
				else if (ev.type === 'tool/call') toolCalls += 1
				else if (ev.type === 'session/title') {
					// 标题折叠规则就是 last-wins，与官方 title 投影一致
					const text = ev.data && ev.data.title
					if (typeof text === 'string' && text.trim() !== '') title = text.trim()
				} else if (ev.type === 'user/message') {
					const data = ev.data || {}
					const source = data.source
					// 只有 source.kind === 'user' 才是真人输入，其余是 agent.inject 合成的上下文
					if (source && source.kind === 'user') prompts.push(textOfContent(data.content, 500))
				}
			}
			// 一条真人输入都没有 = 空会话，对「今天做了什么」没有信息量
			if (prompts.length === 0) return null

			// 首尾各两条改成「滤掉噪声后取首尾若干条 + 长会话补一条最长诉求」。
			// 原先直接 slice(0,2)/slice(-2)，末条经常是「继续」「谢谢」这类零信息量
			// 客套，首条经常是整段粘进来的代码，两条都花了钱却答不上「做了什么」。
			const picked = pickDigestPrompts(prompts)
			return {
				id: cand.id,
				title: cand.title || title || project || cand.id.slice(0, 8),
				cwd,
				project,
				origin: cand.origin,
				createdAt,
				lastAt,
				userMsgs: prompts.length,
				assistantMsgs,
				toolCalls,
				firstPrompts: picked.head,
				lastPrompts: picked.tail,
				keyPrompt: picked.key,
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
				const digestText = buildDigestText(collected.sessions, preset)
				const promptText = buildPrompt(run.date, digestText, settings.language, preset)
				const userMessage = {
					id: 'msg-' + run.runId,
					role: 'user',
					content: [{ type: 'text', text: promptText }],
					source: { kind: 'user' },
				}

				// 省 token 的两道闸门（都不影响正确性，只压上界）：
				// 1) maxTokens 硬顶输出。提示词里写「不超过 600 字」模型经常不听
				//    （实测自动跑写了约 1100 字），只有请求字段能真正兜住。
				//    留一倍余量是免得把正文截断在半句。
				// 2) reasoningEffort 压到该模型支持的最低一档。摘要不需要长思考，
				//    而思考 token 常常比正文还贵；模型不暴露档位就不传。
				const options = {
					provider: selected.provider,
					model: selected.model,
					messages: [userMessage],
					maxTokens: preset.maxTokens,
				}
				const effort = await lowestReasoningEffort(llm, selected.provider, selected.model)
				if (effort !== null) options.reasoningEffort = effort
				console.log(LOG, 'generate', run.date, 'provider=' + selected.provider, 'model=' + selected.model,
					'maxTokens=' + preset.maxTokens, 'effort=' + (effort || 'default'), 'digestChars=' + digestText.length)

				const stream = llm.stream(options)
				for await (const chunk of stream) {
					if (!chunk || typeof chunk.type !== 'string') continue
					if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
						run.text += chunk.text
					} else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
						run.reasoning += chunk.text
						if (run.reasoning.length > 20000) run.reasoning = run.reasoning.slice(-20000)
					} else if (chunk.type === 'finish') {
						// 各家适配器字段名不一，finishReason / reason / stopReason 都见过
						run.finishReason = chunk.finishReason || chunk.reason || chunk.stopReason || null
						break
					}
				}
				if (run.text.trim() === '') throw new Error('模型没有返回内容')
				run.done = true
				run.finishedAt = Date.now()
				persistRun(run)
				console.log(LOG, 'finished', run.date, run.mode, 'textLen=' + run.text.length, 'sessions=' + run.sessions.length,
					'finish=' + (run.finishReason || '-'))
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

				// 完整收集：每个候选一次全量日志读，用来拿计数与诉求正文，也供生成用
				async collect(args) {
					const date = resolveDate(args && args.date)
					const collected = await collectOnce(get, date)
					return {
						date,
						sessions: collected.sessions,
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

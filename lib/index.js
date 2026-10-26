// dsh-work-diary - host half (static package)
// 静态包差异：无 harness builtin，用 webServer 前缀路由
//   POST /dsh-work-diary/api/<op>  (op: saved | collect | start | poll | settings.get | settings.set | models)
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
// 200 字，砍掉 cwd 行，总长压到 600 字——够说清「今天大致做了什么」，实测比
// full 档省一半以上输入。full 档送开头/结尾各两条、各 500 字、保留 cwd。
const VERBOSITY_PRESETS = {
	// maxTokens 是输出硬顶，比字数要求留一倍余量，避免把正文截断在半句
	brief: { headPrompts: 1, tailPrompts: 1, promptChars: 200, keepCwd: false, maxChars: 600, maxTokens: 900, openItems: false },
	full: { headPrompts: 2, tailPrompts: 2, promptChars: 500, keepCwd: true, maxChars: 800, maxTokens: 1600, openItems: true },
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

function truncate(text, max) {
	if (typeof text !== 'string') return ''
	return text.length <= max ? text : text.slice(0, max) + '…'
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
	lines.push('### ' + (item.title || item.project || item.id) + tag)
	// 一行摊平时间与规模，比三个中文标签行省三成
	lines.push('- ' + hm(item.createdAt) + '-' + hm(item.lastAt)
		+ ' · 用户' + item.userMsgs + '/助手' + item.assistantMsgs + '/工具' + item.toolCalls)
	// brief 档不送 cwd：项目分组头已经给了目录，长路径对「做了什么」没有信息量
	if (preset.keepCwd) lines.push('- 目录: ' + (item.cwd || '未知'))
	const head = item.firstPrompts.slice(0, preset.headPrompts)
	const tail = item.lastPrompts.slice(-preset.tailPrompts)
	const headText = truncate(head.join(' | '), preset.promptChars)
	const tailText = truncate(tail.join(' | '), preset.promptChars)
	if (headText !== '' && headText === tailText) {
		// 首尾一样（大多数短会话）只送一条
		lines.push('- 诉求: ' + headText)
	} else {
		if (headText !== '') lines.push('- 开头: ' + headText)
		if (tailText !== '') lines.push('- 结尾: ' + tailText)
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

		async function collectSessions(get, dateStr) {
			const sessionQuery = get('sessionQuery')
			if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
				throw new Error('sessionQuery 服务不可用')
			}
			const bounds = dayBounds(dateStr)
			const startedAt = Date.now()
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
				byId.set(item.sessionId, {
					id: item.sessionId,
					cwd: typeof item.cwd === 'string' ? item.cwd : '',
					lastAt,
					origin: item.origin === 'subagent' ? 'subagent' : '',
					title: projectionTitle(item),
				})
			}
			for (const record of records) {
				const header = record && record.header
				if (!header || typeof header.id !== 'string') continue
				if (byId.has(header.id)) continue
				const createdAt = toMs(header.createdAt)
				if (createdAt < recentFrom) continue
				byId.set(header.id, {
					id: header.id,
					cwd: typeof header.cwd === 'string' ? header.cwd : '',
					lastAt: createdAt,
					origin: header.origin === 'subagent' ? 'subagent' : '',
					title: '',
				})
			}

			const candidates = Array.from(byId.values())
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

			const firstPrompts = prompts.slice(0, 2).filter((t) => t !== '')
			const lastPrompts = prompts.slice(-2).filter((t) => t !== '')
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
				firstPrompts,
				lastPrompts,
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
						break
					}
				}
				if (run.text.trim() === '') throw new Error('模型没有返回内容')
				run.done = true
				run.finishedAt = Date.now()
				persistRun(run)
				console.log(LOG, 'finished', run.date, run.mode, 'textLen=' + run.text.length, 'sessions=' + run.sessions.length)
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

				// 只读会话，不调模型
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

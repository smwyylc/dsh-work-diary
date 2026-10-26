// dsh-work-diary - client half (static package)
// 侧栏图标（sidebar.panellist）+ 中间主面板（main, key = work-diary）。
// 静态差异：host.call -> 同源 fetch(/dsh-work-diary/api/<op>)；无 styles builtin -> apply 时注入 style。
window.__ModuleLoader__.load({
	id: 'dsh-work-diary',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		let React = require('react')

		// 官方 markdown 渲染器（自带流式）。取不到就退回纯文本。
		let MarkdownText = null
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
			if (primitives && typeof primitives.MarkdownText === 'function') MarkdownText = primitives.MarkdownText
		} catch (e) { MarkdownText = null }

		// cordis 的 ctx 只在 apply(ctx) 参数里可见；组件里要用（openSession），先存闭包。
		let pluginCtx = null

		const FALLBACK_SETTINGS = { enabled: true, time: '18:00', provider: '', model: '', language: 'zh', verbosity: 'brief', maxSessions: 40 }

		function hostCall(op, args) {
			return fetch('/dsh-work-diary/api/' + encodeURIComponent(op), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args || {}),
			}).then((r) => r.json().then((j) => {
				if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status))
				return j
			}))
		}

		function pad2(n) { return n < 10 ? '0' + n : String(n) }

		function todayStr() {
			const d = new Date()
			return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
		}

		function shiftDate(dayOffset) {
			const d = new Date()
			const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset)
			return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate())
		}

		function hm(ms) {
			const n = Number(ms)
			if (!Number.isFinite(n) || n <= 0) return '--:--'
			const d = new Date(n)
			return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
		}

		function brief(text, max) {
			const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
			if (s === '') return ''
			return s.length <= max ? s : s.slice(0, max) + '…'
		}

		function errText(e) {
			return (e && e.message) ? e.message : String(e)
		}

		const CSS = [
			'.dsds-root{height:100%;overflow:auto;padding:18px 22px 40px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f2328);}',
			'.dsds-wrap{max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:14px;}',
			'.dsds-title{font-size:16px;font-weight:600;margin:0;}',
			'.dsds-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
			'.dsds-bar-gap{flex:1;}',
			'.dsds-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;}',
			'.dsds-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));}',
			'.dsds-btn.is-active{border-color:var(--dsw-alias-brand-primary,#4f7cff);color:var(--dsw-alias-brand-primary,#4f7cff);}',
			'.dsds-btn:disabled{opacity:.5;cursor:default;}',
			'.dsds-primary{background:var(--dsw-alias-brand-primary,#4f7cff);border:none;color:#fff;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;}',
			'.dsds-primary:hover{filter:brightness(1.05);}',
			'.dsds-primary:disabled{opacity:.5;cursor:default;}',
			'.dsds-date{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px;}',
			'.dsds-status{font-size:12px;color:var(--dsw-alias-label-secondary,#6a737d);}',
			'.dsds-status.is-err{color:var(--dsw-alias-state-error-primary,#d93036);}',
			'.dsds-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,transparent);}',
			'.dsds-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
			'.dsds-card-title{font-size:13px;font-weight:600;margin:0;}',
			'.dsds-md{white-space:normal;font-size:13px;line-height:1.7;}',
			'.dsds-md>:first-child{margin-top:0;}',
			'.dsds-md>:last-child{margin-bottom:0;}',
			'.dsds-plain{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;min-height:20px;}',
			'.dsds-dim{color:var(--dsw-alias-label-secondary,#6a737d);font-size:13px;}',
			'.dsds-caret{display:inline-block;width:2px;height:14px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-brand-primary,#4f7cff);animation:dsds-blink .9s steps(2) infinite;}',
			'@keyframes dsds-blink{0%,49%{opacity:1}50%,100%{opacity:0}}',
			'.dsds-sec-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}',
			'.dsds-sec-title{font-size:13px;font-weight:600;}',
			'.dsds-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}',
			'.dsds-sess{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;padding:10px 12px;cursor:pointer;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:4px;}',
			'.dsds-sess:hover{border-color:var(--dsw-alias-brand-primary,#4f7cff);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));}',
			'.dsds-sess-proj{font-size:12px;color:var(--dsw-alias-brand-primary,#4f7cff);font-weight:600;}',
			'.dsds-sess-title{font-size:13px;font-weight:600;line-height:1.4;word-break:break-word;}',
			'.dsds-sess-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#6a737d);}',
			'.dsds-sess-prompt{font-size:12px;color:var(--dsw-alias-label-secondary,#6a737d);line-height:1.5;word-break:break-word;}',
			'.dsds-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 16px;}',
			'.dsds-field{display:flex;flex-direction:column;gap:4px;}',
			'.dsds-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6a737d);}',
			'.dsds-input,.dsds-select{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:4px 8px;font-size:12px;line-height:20px;min-width:0;}',
			'.dsds-check{display:flex;align-items:center;gap:6px;font-size:12px;}',
			'.dsds-form-foot{display:flex;align-items:center;gap:10px;grid-column:1/-1;}',
			'.dsds-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#1a7f37);}',
		].join('\n')

		function openSession(sessionId) {
			try {
				const ctx = pluginCtx
				if (!ctx) return
				const ui = ctx.get('uiWorkspace')
				if (ui && typeof ui.openSession === 'function') ui.openSession(sessionId)
			} catch (e) { /* ignore */ }
		}

		// 侧栏图标：日历 + 清单，单色线性。props 是 { size, active }，size 为像素数。
		function DailyIcon(props) {
			const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20
			const active = !!(props && props.active)
			return React.createElement('svg', {
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: active ? 1.9 : 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				React.createElement('rect', { key: 'frame', x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }),
				React.createElement('path', { key: 'line', d: 'M3.5 9.5h17' }),
				React.createElement('path', { key: 'pin-l', d: 'M8 3.5v3' }),
				React.createElement('path', { key: 'pin-r', d: 'M16 3.5v3' }),
				React.createElement('path', { key: 'item1', d: 'M7.5 13h2' }),
				React.createElement('path', { key: 'item2', d: 'M7.5 16.5h2' }),
				React.createElement('path', { key: 'item3', d: 'M12 13h4.5' }),
				React.createElement('path', { key: 'item4', d: 'M12 16.5h4.5' }),
			)
		}

		function Field(props) {
			return React.createElement('div', { className: 'dsds-field' },
				React.createElement('span', { className: 'dsds-label' }, props.label),
				props.children,
			)
		}

		function DailyPanel() {
			const [date, setDate] = React.useState(todayStr())
			const [sessions, setSessions] = React.useState([])
			const [truncated, setTruncated] = React.useState(0)
			const [collecting, setCollecting] = React.useState(true)
			const [phase, setPhase] = React.useState('idle')
			const [text, setText] = React.useState('')
			const [reasoning, setReasoning] = React.useState('')
			const [meta, setMeta] = React.useState(null)
			const [error, setError] = React.useState('')
			const [runId, setRunId] = React.useState('')
			const [settings, setSettings] = React.useState(FALLBACK_SETTINGS)
			const [models, setModels] = React.useState({ providers: [], defaultProvider: '', defaultModel: '' })
			const [showSettings, setShowSettings] = React.useState(false)
			const [saving, setSaving] = React.useState(false)
			const [saveState, setSaveState] = React.useState(null)

			// 设置只取一次。模型清单会逐个 provider 打 llm.listModels（网络 I/O），
			// 跟 collect 的全量日志解码抢 Host 时间，所以等用户真打开设置区再取。
			React.useEffect(() => {
				let alive = true
				hostCall('settings.get').then((s) => {
					if (!alive || !s || typeof s !== 'object') return
					setSettings(Object.assign({}, FALLBACK_SETTINGS, s))
				}).catch(() => { /* 用默认值兜底 */ })
				return () => { alive = false }
			}, [])

			React.useEffect(() => {
				if (!showSettings || models.providers.length > 0) return undefined
				let alive = true
				hostCall('models').then((m) => {
					if (!alive || !m) return
					setModels({
						providers: Array.isArray(m.providers) ? m.providers : [],
						defaultProvider: typeof m.defaultProvider === 'string' ? m.defaultProvider : '',
						defaultModel: typeof m.defaultModel === 'string' ? m.defaultModel : '',
					})
				}).catch(() => { /* 列表为空时退化为手动输入 */ })
				return () => { alive = false }
			}, [showSettings, models.providers.length])

			// 切换日期：重置展示态。先秒开已落盘的总结（不碰会话日志，几毫秒），
			// 再后台 collect 会话列表——collect 要全量读当天会话日志，大会话多的
			// 日子要好几秒，不能让用户对着空面板干等。
			React.useEffect(() => {
				let alive = true
				setCollecting(true)
				setError('')
				setText('')
				setReasoning('')
				setMeta(null)
				setRunId('')
				setPhase('idle')
				hostCall('saved', { date }).then((r) => {
					if (!alive || !r || !r.summary || typeof r.summary.text !== 'string' || r.summary.text === '') return
					setText(r.summary.text)
					setMeta({ mode: r.summary.mode, startedAt: r.summary.startedAt, finishedAt: r.summary.finishedAt })
					setPhase('done')
				}).catch(() => { /* 没有既有总结就等 collect */ })
				hostCall('collect', { date }).then((r) => {
					if (!alive || !r) return
					setSessions(Array.isArray(r.sessions) ? r.sessions : [])
					setTruncated(typeof r.truncated === 'number' ? r.truncated : 0)
					if (r.summary && typeof r.summary.text === 'string' && r.summary.text !== '') {
						setText(r.summary.text)
						setMeta({ mode: r.summary.mode, startedAt: r.summary.startedAt, finishedAt: r.summary.finishedAt })
						setPhase('done')
					}
					setCollecting(false)
				}).catch((e) => {
					if (!alive) return
					setError(errText(e))
					setPhase('error')
					setCollecting(false)
				})
				return () => { alive = false }
			}, [date])

			// 轮询增量（400ms），done 时收尾
			React.useEffect(() => {
				if (phase !== 'running' || !runId) return undefined
				let alive = true
				const tick = async () => {
					try {
						const r = await hostCall('poll', { runId })
						if (!alive) return
						if (r && r.error) {
							setError(r.error)
							setPhase('error')
							return
						}
						if (!r) return
						if (typeof r.text === 'string') setText(r.text)
						if (typeof r.reasoning === 'string') setReasoning(r.reasoning)
						if (r.done) {
							if (r.error) {
								setError(r.error)
								setPhase('error')
							} else {
								setMeta({ mode: r.mode, startedAt: r.startedAt, finishedAt: r.finishedAt })
								setPhase('done')
							}
						}
					} catch (e) {
						if (!alive) return
						setError(errText(e))
						setPhase('error')
					}
				}
				tick()
				const id = setInterval(tick, 400)
				return () => { alive = false; clearInterval(id) }
			}, [phase, runId])

			async function generate() {
				setError('')
				setText('')
				setReasoning('')
				setMeta(null)
				setRunId('')
				setPhase('running')
				try {
					const r = await hostCall('start', { date, mode: 'manual' })
					if (r && r.error) {
						setError(r.error)
						setPhase('error')
						return
					}
					if (!r || !r.runId) throw new Error('启动生成失败')
					setRunId(r.runId)
				} catch (e) {
					setError(errText(e))
					setPhase('error')
				}
			}

			async function saveSettings() {
				if (saving) return
				setSaving(true)
				setSaveState(null)
				try {
					const patch = {
						enabled: !!settings.enabled,
						time: settings.time,
						provider: settings.provider,
						model: settings.model,
						language: settings.language,
						verbosity: settings.verbosity === 'full' ? 'full' : 'brief',
						maxSessions: settings.maxSessions,
					}
					const next = await hostCall('settings.set', patch)
					if (next && next.error) throw new Error(next.error)
					if (next && typeof next === 'object') setSettings(Object.assign({}, FALLBACK_SETTINGS, next))
					setSaveState({ ok: true, text: '已保存' })
				} catch (e) {
					setSaveState({ ok: false, text: '保存失败：' + errText(e) })
				} finally {
					setSaving(false)
				}
			}

			function patchSettings(patch) {
				setSettings(Object.assign({}, settings, patch))
			}

			const streaming = phase === 'running'
			const showReasoning = streaming && text === '' && reasoning !== ''
			const useMarkdown = MarkdownText !== null && text !== ''
			// 这一天已经有落盘总结：按钮要写成「重新生成」，提醒再点就是再一次模型调用
			const hasSummary = text !== '' && phase === 'done'

			let statusText = ''
			if (streaming) statusText = text !== '' ? '正在生成…' : '正在读取会话…'
			else if (phase === 'error') statusText = '失败：' + (error || '未知原因')
			else if (phase === 'done' && meta) {
				statusText = '已完成于 ' + hm(meta.finishedAt || meta.startedAt) + (meta.mode === 'auto' ? '（自动 ' + (settings.time || '18:00') + '）' : '（手动）')
			} else statusText = collecting ? '正在读取会话…' : '未生成'

			const providers = Array.isArray(models.providers) ? models.providers : []
			const providerIds = []
			for (const p of providers) {
				if (p && typeof p.id === 'string' && p.id !== '') providerIds.push(p.id)
			}
			if (settings.provider && providerIds.indexOf(settings.provider) === -1) providerIds.push(settings.provider)
			const currentProvider = providers.find((p) => p && p.id === settings.provider)
			const modelIds = currentProvider && Array.isArray(currentProvider.models) ? currentProvider.models : []

			return React.createElement('div', { className: 'dsds-root' },
				React.createElement('div', { className: 'dsds-wrap' },
					// 工具条
					React.createElement('div', { className: 'dsds-bar' },
						React.createElement('h2', { className: 'dsds-title' }, '日记'),
						React.createElement('span', { className: 'dsds-bar-gap' }),
						React.createElement('button', {
							className: 'dsds-btn' + (date === todayStr() ? ' is-active' : ''),
							onClick: () => setDate(todayStr()),
						}, '今天'),
						React.createElement('button', {
							className: 'dsds-btn' + (date === shiftDate(-1) ? ' is-active' : ''),
							onClick: () => setDate(shiftDate(-1)),
						}, '昨天'),
						React.createElement('input', {
							className: 'dsds-date',
							type: 'date',
							value: date,
							onChange: (e) => setDate(e.target.value || todayStr()),
						}),
						// 已有总结时按钮写明「重新生成」：每点一次就是一次真实的模型
						// 调用，不能让人顺着肌肉记忆重复点。生成中/读取中一律禁用，
						// 免得连点开出多个 run。
						React.createElement('button', {
							className: 'dsds-primary',
							disabled: streaming || collecting,
							onClick: () => { generate() },
						}, streaming ? '生成中…' : (hasSummary ? '重新生成' : '生成总结')),
						React.createElement('button', {
							className: 'dsds-btn',
							onClick: () => setShowSettings(!showSettings),
						}, showSettings ? '收起设置' : '设置'),
						React.createElement('span', { className: 'dsds-status' + (phase === 'error' ? ' is-err' : '') }, statusText),
					),

					// 设置区（内联展开，不另开弹窗）
					showSettings ? React.createElement('div', { className: 'dsds-card' },
						React.createElement('div', { className: 'dsds-form' },
							React.createElement(Field, { label: '自动执行' },
								React.createElement('label', { className: 'dsds-check' },
									React.createElement('input', {
										type: 'checkbox',
										checked: !!settings.enabled,
										onChange: (e) => patchSettings({ enabled: e.target.checked }),
									}),
									React.createElement('span', null, '每天定时生成'),
								),
							),
							React.createElement(Field, { label: '执行时间（本地时间）' },
								React.createElement('input', {
									className: 'dsds-input',
									type: 'time',
									value: settings.time || '18:00',
									onChange: (e) => patchSettings({ time: e.target.value || '18:00' }),
								}),
							),
							React.createElement(Field, { label: '模型 provider' },
								React.createElement('select', {
									className: 'dsds-select',
									value: settings.provider || '',
									onChange: (e) => patchSettings({ provider: e.target.value, model: '' }),
								},
									React.createElement('option', { value: '' }, settings.provider === '' && models.defaultProvider ? ('跟随默认模型（' + models.defaultProvider + '）') : '跟随默认模型'),
									providerIds.map((id) => React.createElement('option', { key: id, value: id }, id)),
								),
							),
							React.createElement(Field, { label: '模型 model' },
								settings.provider !== '' && modelIds.length > 0
									? React.createElement('select', {
										className: 'dsds-select',
										value: settings.model || '',
										onChange: (e) => patchSettings({ model: e.target.value }),
									},
										React.createElement('option', { value: '' }, '跟随默认模型'),
										modelIds.map((id) => React.createElement('option', { key: id, value: id }, id)),
									)
									: React.createElement('input', {
										className: 'dsds-input',
										type: 'text',
										placeholder: models.defaultModel ? ('留空则用 ' + models.defaultModel) : '留空则用默认模型',
										value: settings.model || '',
										onChange: (e) => patchSettings({ model: e.target.value }),
									}),
							),
							React.createElement(Field, { label: '详细程度' },
								React.createElement('select', {
									className: 'dsds-select',
									value: settings.verbosity === 'full' ? 'full' : 'brief',
									onChange: (e) => patchSettings({ verbosity: e.target.value }),
								},
									React.createElement('option', { value: 'brief' }, '精简（省 token，只送首尾各一条诉求）'),
									React.createElement('option', { value: 'full' }, '完整（首尾各两条、保留目录，更细但更贵）'),
								),
							),
							React.createElement(Field, { label: '总结语言' },
								React.createElement('select', {
									className: 'dsds-select',
									value: settings.language || 'zh',
									onChange: (e) => patchSettings({ language: e.target.value }),
								},
									React.createElement('option', { value: 'zh' }, '中文'),
									React.createElement('option', { value: 'en' }, 'English'),
								),
							),
							React.createElement('div', { className: 'dsds-form-foot' },
								React.createElement('button', {
									className: 'dsds-primary',
									disabled: saving,
									onClick: () => { saveSettings() },
								}, saving ? '保存中…' : '保存设置'),
								saveState ? React.createElement('span', {
									className: saveState.ok ? 'dsds-ok' : 'dsds-status is-err',
								}, saveState.text) : null,
							),
						),
					) : null,

					// 正文区
					React.createElement('div', { className: 'dsds-card' },
						React.createElement('div', { className: 'dsds-card-head' },
							React.createElement('h3', { className: 'dsds-card-title' }, date + ' 日记'),
							React.createElement('span', { className: 'dsds-status' + (phase === 'error' ? ' is-err' : '') }, statusText),
						),
						React.createElement('div', { style: { marginTop: '8px' } },
							showReasoning
								? React.createElement('div', { className: 'dsds-dim' }, reasoning)
								: (useMarkdown
									? React.createElement('div', { className: 'dsds-md' }, React.createElement(MarkdownText, { text, streaming }))
									: (text !== ''
										? React.createElement('div', { className: 'dsds-plain' }, text)
										: ((streaming || collecting)
											? React.createElement('div', { className: 'dsds-dim' }, '正在读取会话或正在生成…')
											: React.createElement('div', { className: 'dsds-dim' }, '还没有生成这一天的总结，点上方「生成总结」。')))),
							streaming && !useMarkdown ? React.createElement('span', { className: 'dsds-caret' }) : null,
						),
					),

					// 会话明细（始终展示，不依赖总结）
					React.createElement('div', { className: 'dsds-card' },
						React.createElement('div', { className: 'dsds-sec-head' },
							React.createElement('span', { className: 'dsds-sec-title' }, '当天会话明细'),
							React.createElement('span', { className: 'dsds-status' },
								'共 ' + (collecting ? '…' : sessions.length) + ' 个会话'
								+ (truncated > 0 ? '，另有 ' + truncated + ' 个未纳入总结' : '')),
						),
						collecting
							? React.createElement('div', { className: 'dsds-dim' }, '正在读取会话…')
							: (sessions.length === 0
								? React.createElement('div', { className: 'dsds-dim' }, '今天还没有会话记录。')
								: React.createElement('div', { className: 'dsds-grid' },
									sessions.map((s) => React.createElement('div', {
										key: s.id,
										className: 'dsds-sess',
										title: '在 DSH 中打开这个会话',
										onClick: () => openSession(s.id),
									},
										React.createElement('span', { className: 'dsds-sess-proj' }, s.project || '未命名项目'),
										React.createElement('span', { className: 'dsds-sess-title' },
										(s.title || s.id) + (s.origin === 'subagent' ? '（子代理）' : '')),
										React.createElement('span', { className: 'dsds-sess-meta' },
											hm(s.createdAt) + ' - ' + hm(s.lastAt) + ' · 消息 ' + (s.userMsgs || 0) + '/' + (s.assistantMsgs || 0) + ' · 工具 ' + (s.toolCalls || 0)),
										React.createElement('span', { className: 'dsds-sess-prompt' },
											brief((s.firstPrompts && s.firstPrompts[0]) || '', 60) || '（没有可展示的用户输入）'),
									)),
								)),
					),

					error !== '' && phase !== 'error'
						? React.createElement('div', { className: 'dsds-status is-err' }, error)
						: null,
				),
			)
		}

		function apply(ctx) {
			pluginCtx = ctx

			// 静态包无 styles builtin：每次 apply 就地更新同一个 style 标签（不新建、不跳过），
			// effect 负责在包卸载时移除。重复 apply（HMR/重挂）不会留下重复标签。
			ctx.effect(() => {
				if (typeof document === 'undefined') return undefined
				let tag = document.getElementById('dsh-work-diary-styles')
				if (tag === null) {
					tag = document.createElement('style')
					tag.id = 'dsh-work-diary-styles'
					document.head.appendChild(tag)
				}
				tag.textContent = CSS
				return () => { tag.remove() }
			}, 'dsh-work-diary: styles')

			const slots = ctx.get('slots')
			if (slots === undefined) return

			// 侧栏图标
			slots.inject('sidebar.panellist', () => slots.register(
				{ name: 'sidebar.panellist', id: 'work-diary', order: 50, label: '日记' },
				DailyIcon,
			))

			// 中间主面板：key 与侧栏图标 id 一致，点图标时由壳派发 main
			slots.inject('main', () => slots.register(
				{ name: 'main', key: 'work-diary' },
				DailyPanel,
			))
		}

		// 与 dsh-session-summary 同款：声明 slots 硬依赖，否则 apply 早于 slots 就绪时注册被静默跳过。
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports
	},
})

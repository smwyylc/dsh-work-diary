// 模型流的失败要上报真实原因。用假 async iterable 喂 chunk，覆盖 finish.reason
// 的五个 kind、兼容取值链，以及「正常结束但正文为空」那条兜底报错。
import test from 'node:test'
import assert from 'node:assert/strict'

import { consumeStream } from '../lib/index.js'

function newRun() {
	return { text: '', reasoning: '', finishReason: null }
}

function streamOf(chunks) {
	return (async function* () {
		for (const chunk of chunks) yield chunk
	})()
}

test('finish 是 error 时抛真实原因：同时带 code 和 message', async () => {
	const run = newRun()
	await assert.rejects(
		consumeStream(streamOf([
			{ type: 'text-delta', index: 0, text: '部分正文' },
			{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_UNREACHABLE', message: 'dial tcp: no such host' } } },
		]), run),
		(e) => {
			assert.match(e.message, /UPSTREAM_UNREACHABLE/)
			assert.match(e.message, /no such host/)
			// 不能是那句通用的「没有返回内容」
			assert.doesNotMatch(e.message, /模型没有返回内容/)
			return true
		},
	)
	assert.equal(run.finishReason, 'error')
})

test('finish 是 aborted 时同样抛真实原因', async () => {
	const run = newRun()
	await assert.rejects(
		consumeStream(streamOf([
			{ type: 'text-delta', index: 0, text: '半句' },
			{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } },
		]), run),
		(e) => {
			assert.match(e.message, /ABORTED/)
			assert.match(e.message, /cancelled/)
			return true
		},
	)
	assert.equal(run.finishReason, 'aborted')
})

test('failure 缺字段时仍只抛一条可读的消息，不抛 TypeError', async () => {
	await assert.rejects(
		consumeStream(streamOf([{ type: 'finish', reason: { kind: 'error' } }]), newRun()),
		(e) => {
			assert.ok(e instanceof Error)
			assert.match(e.message, /模型调用出错/)
			return true
		},
	)
})

test('finish 是 stop 且有正文时正常结束', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '今天的' },
		{ type: 'text-delta', index: 1, text: '总结。' },
		{ type: 'finish', reason: { kind: 'stop' } },
	]), run)
	assert.equal(run.text, '今天的总结。')
	assert.equal(run.finishReason, 'stop')
})

test('finish 是 stop 但一个 text-delta 都没有时，报模型没有返回内容', async () => {
	await assert.rejects(
		consumeStream(streamOf([{ type: 'finish', reason: { kind: 'stop' } }]), newRun()),
		(e) => {
			assert.match(e.message, /模型没有返回内容/)
			return true
		},
	)
})

test('finish 是 max-tokens 且有正文时，finishReason 是字符串 max-tokens', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '被截断的正文' },
		{ type: 'finish', reason: { kind: 'max-tokens' } },
	]), run)
	assert.equal(typeof run.finishReason, 'string')
	assert.equal(run.finishReason, 'max-tokens')
})

test('finish 是 tool-calls 时映射成字符串', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish', reason: { kind: 'tool-calls' } },
	]), run)
	assert.equal(run.finishReason, 'tool-calls')
})

test('reason 字段缺失时退化成 null，不抛类型错误', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish' },
	]), run)
	assert.equal(run.finishReason, null)
})

test('reason 不是对象时退化成 null，不抛类型错误', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish', reason: 42 },
	]), run)
	assert.equal(run.finishReason, null)
})

test('kind 认不出来时退回兼容取值链，只接受字符串', async () => {
	const withStopReason = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish', reason: { kind: 'weird' }, stopReason: 'length' },
	]), withStopReason)
	assert.equal(withStopReason.finishReason, 'length')

	const withFinishReason = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish', reason: { kind: 'weird' }, finishReason: 'end_turn' },
	]), withFinishReason)
	assert.equal(withFinishReason.finishReason, 'end_turn')

	const nothing = newRun()
	await consumeStream(streamOf([
		{ type: 'text-delta', index: 0, text: '正文' },
		{ type: 'finish', reason: { kind: 'weird' } },
	]), nothing)
	assert.equal(nothing.finishReason, null)
})

test('reasoning-delta 进 run.reasoning，不影响正文判定', async () => {
	const run = newRun()
	await consumeStream(streamOf([
		{ type: 'reasoning-delta', index: 0, text: '想一想' },
		{ type: 'text-delta', index: 1, text: '正文' },
		{ type: 'finish', reason: { kind: 'stop' } },
	]), run)
	assert.equal(run.reasoning, '想一想')
	assert.equal(run.text, '正文')
})

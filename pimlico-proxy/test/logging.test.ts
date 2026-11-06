import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createLogger, type CallLogEntry } from '../src/logging.js'

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = []
  return { lines, sink: (line: string): void => void lines.push(line) }
}

const fullEntry: CallLogEntry = {
  method: 'pm_sponsorUserOperation',
  chainId: 11_155_111,
  userId: 'user-1',
  outcome: 'rpc_error',
  status: 502,
  code: -32_000,
  latencyMs: 12.7,
  ip: '203.0.113.7',
}

describe('createLogger', () => {
  test('emits exactly one JSON line with the expected keys in the expected order', () => {
    const { lines, sink } = capture()
    const log = createLogger(sink)

    log(fullEntry)

    assert.equal(lines.length, 1)
    const line = lines[0]!
    assert.equal(
      line,
      '{"method":"pm_sponsorUserOperation","chainId":11155111,"userId":"user-1",' +
        '"outcome":"rpc_error","status":502,"code":-32000,"latencyMs":13,' +
        '"ip":"203.0.113.7"}',
    )
    assert.ok(!line.includes('\n'))

    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), [
      'method',
      'chainId',
      'userId',
      'outcome',
      'status',
      'code',
      'latencyMs',
      'ip',
    ])
    assert.deepEqual(parsed, {
      method: 'pm_sponsorUserOperation',
      chainId: 11_155_111,
      userId: 'user-1',
      outcome: 'rpc_error',
      status: 502,
      code: -32_000,
      latencyMs: 13,
      ip: '203.0.113.7',
    })
  })

  test('rounds latencyMs to a whole millisecond', () => {
    const { lines, sink } = capture()
    const log = createLogger(sink)

    log({ ...fullEntry, latencyMs: 0.4 })
    log({ ...fullEntry, latencyMs: 7.5 })
    log({ ...fullEntry, latencyMs: 7.49 })

    const latencies = lines.map((line) => (JSON.parse(line) as CallLogEntry).latencyMs)
    assert.deepEqual(latencies, [0, 8, 7])
  })

  test('omits code and ip entirely when undefined', () => {
    const { lines, sink } = capture()
    const log = createLogger(sink)

    log({
      method: 'eth_chainId',
      chainId: 1,
      userId: null,
      outcome: 'ok',
      status: 200,
      latencyMs: 3,
    })

    assert.ok(!lines[0]!.includes('"code":null'))
    assert.ok(!lines[0]!.includes('"ip":null'))

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), [
      'method',
      'chainId',
      'userId',
      'outcome',
      'status',
      'latencyMs',
    ])
    assert.ok(!('code' in parsed))
    assert.ok(!('ip' in parsed))
  })

  test('keeps userId null rather than dropping the key', () => {
    const { lines, sink } = capture()
    const log = createLogger(sink)

    log({
      method: 'eth_chainId',
      chainId: 1,
      userId: null,
      outcome: 'http_error',
      status: 500,
      latencyMs: 1,
    })

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    assert.equal(parsed.userId, null)
    assert.ok('userId' in parsed)
  })

  test('emits code without ip, and ip without code', () => {
    const { lines, sink } = capture()
    const log = createLogger(sink)

    log({
      method: 'eth_sendRawTransaction',
      chainId: 8453,
      userId: 'u',
      outcome: 'rpc_error',
      status: 200,
      code: -32_600,
      latencyMs: 5,
    })
    log({
      method: 'eth_sendRawTransaction',
      chainId: 8453,
      userId: 'u',
      outcome: 'ok',
      status: 200,
      latencyMs: 5,
      ip: '198.51.100.2',
    })

    assert.deepEqual(Object.keys(JSON.parse(lines[0]!) as object), [
      'method',
      'chainId',
      'userId',
      'outcome',
      'status',
      'code',
      'latencyMs',
    ])
    assert.deepEqual(Object.keys(JSON.parse(lines[1]!) as object), [
      'method',
      'chainId',
      'userId',
      'outcome',
      'status',
      'latencyMs',
      'ip',
    ])
  })

  test('calls the sink exactly once per entry', () => {
    let calls = 0
    const log = createLogger((): void => {
      calls += 1
    })

    log(fullEntry)
    assert.equal(calls, 1)

    log(fullEntry)
    log(fullEntry)
    assert.equal(calls, 3)
  })

  test('a throwing sink does not propagate and does not stop later entries', () => {
    let calls = 0
    const log = createLogger((): void => {
      calls += 1
      throw new Error('sink exploded')
    })

    assert.doesNotThrow(() => log(fullEntry))
    assert.doesNotThrow(() => log(fullEntry))
    assert.equal(calls, 2)
  })

  test('default sink writes one newline-terminated line to stdout', () => {
    const original = process.stdout.write
    let written = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write

    try {
      createLogger()(fullEntry)
    } finally {
      process.stdout.write = original
    }

    assert.equal(
      written,
      '{"method":"pm_sponsorUserOperation","chainId":11155111,"userId":"user-1",' +
        '"outcome":"rpc_error","status":502,"code":-32000,"latencyMs":13,' +
        '"ip":"203.0.113.7"}\n',
    )
  })
})

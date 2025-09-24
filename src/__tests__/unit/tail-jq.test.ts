import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { LogEntry } from '../../types'

const { QueryAPI } = await import('../../api/query')
const { tailLogs, __setJqRunnerForTests } = await import('../../commands/tail')

describe('tailLogs jq integration', () => {
  const originalExecute = QueryAPI.prototype.execute
  const originalStdoutWrite = process.stdout.write
  const originalConsoleLog = console.log
  const originalConsoleError = console.error

  let stdoutSpy: ReturnType<typeof mock>
  let logSpy: ReturnType<typeof mock>
  let errorSpy: ReturnType<typeof mock>
  const executeMock = mock<(_options: any) => Promise<LogEntry[]>>(async () => [])

  beforeEach(() => {
    stdoutSpy = mock(() => {})
    logSpy = mock(() => {})
    errorSpy = mock(() => {})

    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write
    console.log = logSpy as unknown as typeof console.log
    console.error = errorSpy as unknown as typeof console.error

    executeMock.mockReset()
    QueryAPI.prototype.execute = function (options: any) {
      return executeMock(options)
    }
  })

  afterEach(() => {
    process.stdout.write = originalStdoutWrite
    console.log = originalConsoleLog
    console.error = originalConsoleError
    QueryAPI.prototype.execute = originalExecute
    __setJqRunnerForTests()
  })

  it('pipes formatted JSON through jq when filter is provided', async () => {
    const jqMock = mock(() => ({ status: 0, stdout: '"trimmed"\n' }))
    __setJqRunnerForTests(jqMock as any)

    executeMock.mockResolvedValueOnce([
      { dt: '2025-09-24 12:00:00.000000', raw: '{}', message: 'hello' },
    ])

    await tailLogs({ format: 'json', jq: '.[]', limit: 1 })

    expect(jqMock.mock.calls.length).toBe(1)
    const args = jqMock.mock.calls[0]
    expect(args[0]).toBe('jq')
    expect(args[1]).toEqual(['.[]'])
    expect(stdoutSpy.mock.calls.map((call) => call[0])).toContain('"trimmed"\n')
    expect(logSpy.mock.calls.length).toBe(0)
    expect(errorSpy.mock.calls.length).toBe(0)
  })

  it('falls back to raw payload when jq exits with error', async () => {
    const jqMock = mock(() => ({ status: 2, stdout: '', stderr: 'parse error' }))
    __setJqRunnerForTests(jqMock as any)

    executeMock.mockResolvedValueOnce([
      { dt: '2025-09-24 12:00:00.000000', raw: '{}', message: 'hello' },
    ])

    await tailLogs({ format: 'json', jq: '.[]', limit: 1 })

    expect(jqMock.mock.calls.length).toBe(1)
    expect(errorSpy.mock.calls.some((call) => `${call[0]}`.includes('jq exited with status 2'))).toBe(true)
    expect(logSpy.mock.calls.length).toBe(1)
    const payload = logSpy.mock.calls[0][0]
    expect(typeof payload).toBe('string')
    expect(payload).toContain('hello')
    expect(stdoutSpy.mock.calls.length).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { LogEntry } from '../../types'

const executeMock = mock<(_options: any) => Promise<LogEntry[]>>(async () => [])

const { QueryAPI } = await import('../../api/query')
const { tailLogs } = await import('../../commands/tail')

describe('tailLogs multi-source correlation', () => {
  const originalLog = console.log
  const originalError = console.error
  const originalExecute = QueryAPI.prototype.execute
  let logSpy: ReturnType<typeof mock>
  let errorSpy: ReturnType<typeof mock>

  beforeEach(() => {
    executeMock.mockReset()
    logSpy = mock(() => {})
    errorSpy = mock(() => {})
    console.log = logSpy as unknown as typeof console.log
    console.error = errorSpy as unknown as typeof console.error

    // Override QueryAPI execute
    QueryAPI.prototype.execute = function (options: any) {
      return executeMock(options)
    }

  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    QueryAPI.prototype.execute = originalExecute
  })

  it('merges multiple sources and annotates each entry with its origin', async () => {
    executeMock.mockImplementation(async (options: any) => {
      const fixtures: Record<string, LogEntry[]> = {
        'source-a': [
          { dt: '2025-09-24 12:00:05.000000', raw: '{}', message: 'A newest' },
          { dt: '2025-09-24 11:59:00.000000', raw: '{}', message: 'A older' },
        ],
        'source-b': [
          { dt: '2025-09-24 12:00:07.000000', raw: '{}', message: 'B newest' },
          { dt: '2025-09-24 12:00:01.000000', raw: '{}', message: 'B older' },
        ],
      }

      const dataset = fixtures[options.source as string] ?? []
      const limit = typeof options.limit === 'number' ? options.limit : undefined
      return limit ? dataset.slice(0, limit) : dataset
    })

    await tailLogs({ sources: ['source-a', 'source-b'], format: 'json', limit: 3 })

    expect(executeMock.mock.calls.length).toBe(2)
    expect(new Set(executeMock.mock.calls.map((call) => call[0].source))).toEqual(
      new Set(['source-a', 'source-b']),
    )

    expect(logSpy.mock.calls.length).toBe(1)
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string)

    expect(Array.isArray(payload)).toBe(true)
    expect(payload).toHaveLength(3)
    expect(payload.map((entry: any) => entry.source)).toEqual([
      'source-b',
      'source-a',
      'source-b',
    ])
    expect(payload[0].dt).toBe('2025-09-24 12:00:07.000000')
    expect(errorSpy.mock.calls.length).toBe(0)
  })
})

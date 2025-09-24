import chalk from 'chalk'
import { QueryAPI } from '../api/query'
import type { LogEntry, QueryOptions } from '../types'
import { loadConfig, resolveSourceAlias } from '../utils/config'
import { formatOutput, type OutputFormat } from '../utils/formatter'

type TailRuntimeOptions = {
  follow?: boolean
  interval?: number
  format?: string
}

type TailOptions = QueryOptions & TailRuntimeOptions & {
  sources?: string[]
}

type LogEntryWithSource = LogEntry & { source: string }

export async function tailLogs(options: TailOptions): Promise<void> {
  const api = new QueryAPI()
  const config = loadConfig()

  const { follow, interval, format, sources: multiSourceOption, ...queryOptions } = options

  const limit = normalizeLimit(queryOptions.limit)
  queryOptions.limit = limit

  const resolvedSource = resolveSourceAlias(queryOptions.source)
  if (resolvedSource) {
    queryOptions.source = resolvedSource
  }

  const resolvedSources = new Set<string>()
  if (resolvedSource) {
    resolvedSources.add(resolvedSource)
  }

  if (multiSourceOption?.length) {
    for (const candidate of multiSourceOption) {
      const resolved = resolveSourceAlias(candidate)
      if (resolved) {
        resolvedSources.add(resolved)
      }
    }
  }

  if (resolvedSources.size === 0) {
    const defaultSource = resolveSourceAlias(config.defaultSource)
    if (defaultSource) {
      resolvedSources.add(defaultSource)
    }
  }

  try {
    if (resolvedSources.size <= 1) {
      if (resolvedSources.size === 1) {
        queryOptions.source = [...resolvedSources][0]
      }

      if (queryOptions.source === undefined) {
        queryOptions.source = resolvedSource
      }

      await runSingleSource(api, queryOptions, { follow, interval, format })
      return
    }

    queryOptions.source = undefined
    await runMultiSource(api, queryOptions, { follow, interval, format }, [...resolvedSources])
  } catch (error: any) {
    console.error(chalk.red(`Tail error: ${error.message}`))
    process.exit(1)
  }
}

async function runSingleSource(
  api: QueryAPI,
  options: QueryOptions,
  runtime: TailRuntimeOptions,
): Promise<void> {
  const outputFormat = resolveFormat(runtime.format)
  let lastTimestamp: string | null = null

  const results = await api.execute(options)

  if (results.length > 0) {
    console.log(formatOutput(results, outputFormat))
    lastTimestamp = results[0].dt
  }

  if (!runtime.follow) {
    return
  }

  console.error(chalk.gray('\nFollowing logs... (Press Ctrl+C to stop)'))
  const intervalMs = resolveInterval(runtime.interval)
  const pollLimit = Math.max(1, Math.min(50, options.limit ?? 50))
  const sinceFallback = options.since ?? '1m'

  setInterval(async () => {
    try {
      const pollOptions: QueryOptions = {
        ...options,
        limit: pollLimit,
        since: lastTimestamp || sinceFallback,
      }

      const newResults = await api.execute(pollOptions)
      if (newResults.length === 0) {
        return
      }

      const filtered = lastTimestamp ? newResults.filter((entry) => entry.dt > lastTimestamp!) : newResults
      if (filtered.length === 0) {
        return
      }

      console.log(formatOutput(filtered, outputFormat))
      lastTimestamp = filtered[0].dt
    } catch (error: any) {
      console.error(chalk.red(`Polling error: ${error.message}`))
    }
  }, intervalMs)

  process.stdin.resume()
}

async function runMultiSource(
  api: QueryAPI,
  baseOptions: QueryOptions,
  runtime: TailRuntimeOptions,
  sources: string[],
): Promise<void> {
  const outputFormat = resolveFormat(runtime.format)
  const limit = baseOptions.limit ?? 100
  const perSourceLatest = new Map<string, string>()

  const collect = async (
    sinceMap?: Map<string, string>,
    limitOverride?: number,
    fallbackSince?: string,
  ): Promise<{ combined: LogEntryWithSource[]; latestBySource: Map<string, string> }> => {
    const limitPerSource = Math.max(1, limitOverride ?? limit)
    const combined: LogEntryWithSource[] = []
    const latestBySource = new Map<string, string>()

    for (const source of sources) {
      const perSourceOptions: QueryOptions = {
        ...baseOptions,
        source,
        limit: limitPerSource,
      }

      const sinceCandidate =
        (sinceMap && sinceMap.get(source)) ?? baseOptions.since ?? fallbackSince
      perSourceOptions.since = sinceCandidate || undefined

      const result = await api.execute(perSourceOptions)
      if (result.length > 0) {
        latestBySource.set(source, result[0].dt)
        for (const entry of result) {
          combined.push({ ...entry, source })
        }
      }
    }

    combined.sort((a, b) => {
      if (a.dt === b.dt) return 0
      return a.dt < b.dt ? 1 : -1
    })

    return {
      combined: combined.slice(0, limitPerSource),
      latestBySource,
    }
  }

  const { combined: initialCombined, latestBySource } = await collect()
  for (const [source, dt] of latestBySource) {
    perSourceLatest.set(source, dt)
  }

  if (initialCombined.length > 0) {
    console.log(formatOutput(initialCombined, outputFormat))
  }

  if (!runtime.follow) {
    return
  }

  console.error(chalk.gray('\nFollowing logs... (Press Ctrl+C to stop)'))
  const intervalMs = resolveInterval(runtime.interval)
  const pollLimit = Math.max(1, Math.min(50, limit))
  const fallbackSince = baseOptions.since ? undefined : '1m'

  setInterval(async () => {
    try {
      const { combined, latestBySource: followLatest } = await collect(
        perSourceLatest,
        pollLimit,
        fallbackSince,
      )

      if (combined.length > 0) {
        const newEntries = combined.filter((entry) => {
          const previous = perSourceLatest.get(entry.source)
          return !previous || entry.dt > previous
        })

        if (newEntries.length > 0) {
          console.log(formatOutput(newEntries, outputFormat))
        }
      }

      for (const [source, dt] of followLatest) {
        const previous = perSourceLatest.get(source)
        if (!previous || dt > previous) {
          perSourceLatest.set(source, dt)
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Polling error: ${error.message}`))
    }
  }, intervalMs)

  process.stdin.resume()
}

function resolveFormat(format?: string): OutputFormat {
  if (format === 'json' || format === 'table' || format === 'csv' || format === 'pretty') {
    return format
  }
  return 'pretty'
}

function resolveInterval(value?: number | string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return 2000
}

function normalizeLimit(limit?: number): number {
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit)
  }
  return 100
}

export async function showErrors(options: QueryOptions & { format?: string; sources?: string[] }): Promise<void> {
  return tailLogs({
    ...options,
    level: 'error',
  })
}

export async function showWarnings(
  options: QueryOptions & { format?: string; sources?: string[] },
): Promise<void> {
  return tailLogs({
    ...options,
    level: 'warning',
  })
}

export async function searchLogs(
  pattern: string,
  options: QueryOptions & { format?: string; sources?: string[] },
): Promise<void> {
  return tailLogs({
    ...options,
    search: pattern,
  })
}

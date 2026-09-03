/**
 * DeepSeek list prices and the peak / off-peak calendar.
 * Source: https://api-docs.deepseek.com/quick_start/pricing (checked 2026-09-04).
 * Prices are USD per 1M tokens. Off-peak is exactly half of peak.
 * Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Everything else is off-peak.
 */
import type { TimeBand, Usage } from './types.js'

export interface ModelPrice {
  hit: { peak: number; offpeak: number }
  miss: { peak: number; offpeak: number }
  output: { peak: number; offpeak: number }
}

export interface PriceTable {
  asOf: string
  currency: 'USD'
  models: Record<string, ModelPrice>
  /** Peak windows in UTC: weekday numbers (1 = Monday … 5 = Friday) and [startHour, endHour) pairs. */
  peak: { weekdays: number[]; hours: Array<[number, number]> }
}

const flash: ModelPrice = {
  hit: { peak: 0.014, offpeak: 0.007 },
  miss: { peak: 0.44, offpeak: 0.22 },
  output: { peak: 1.32, offpeak: 0.66 },
}

export const DEEPSEEK_PRICES: PriceTable = {
  asOf: '2026-09-04',
  currency: 'USD',
  models: {
    'deepseek-v4-flash': flash,
    'deepseek-v4-flash-vision-exp': flash,
    'deepseek-v4-pro': {
      hit: { peak: 0.044, offpeak: 0.022 },
      miss: { peak: 1.32, offpeak: 0.66 },
      output: { peak: 3.96, offpeak: 1.98 },
    },
  },
  peak: { weekdays: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] },
}

/** Which price band a request at `timeMs` (unix ms) falls in. */
export function bandAt(timeMs: number, table: PriceTable = DEEPSEEK_PRICES): TimeBand {
  const d = new Date(timeMs)
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  if (!table.peak.weekdays.includes(weekday)) return 'offpeak'
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60
  for (const [start, end] of table.peak.hours) if (hour >= start && hour < end) return 'peak'
  return 'offpeak'
}

/** Price of one call's usage in USD at the given band; unknown models price at 0 and are reported by the caller. */
export function priceUsage(model: string, band: TimeBand, u: Usage, table: PriceTable = DEEPSEEK_PRICES): number {
  const p = table.models[model]
  if (p === undefined) return 0
  return (u.hit * p.hit[band] + u.miss * p.miss[band] + u.output * p.output[band]) / 1_000_000
}

export function knownModel(model: string, table: PriceTable = DEEPSEEK_PRICES): boolean {
  return table.models[model] !== undefined
}

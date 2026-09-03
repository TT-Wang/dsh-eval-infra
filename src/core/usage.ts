/**
 * Normalize the token-usage shapes seen on dsh session events into hit / miss / output / reasoning.
 * dsh (`TokenUsage`): inputTokens = billed (miss) input, cacheReadTokens = cache-hit input.
 * OpenAI-style: prompt_tokens is the total; hits in prompt_cache_hit_tokens or prompt_tokens_details.cached_tokens.
 */
import type { Usage } from './types.js'

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function normalizeUsage(u: unknown): Usage | undefined {
  if (u === null || typeof u !== 'object') return undefined
  const r = u as Record<string, unknown>
  const promptDetails = (r['prompt_tokens_details'] ?? r['promptTokensDetails']) as Record<string, unknown> | undefined
  const completionDetails = (r['completion_tokens_details'] ?? r['completionTokensDetails']) as Record<string, unknown> | undefined
  const hitDsh = num(r['cacheReadTokens']) ?? num(r['cache_read_tokens'])
  const hit = num(r['prompt_cache_hit_tokens']) ?? num(r['promptCacheHitTokens']) ?? hitDsh
    ?? num(promptDetails?.['cached_tokens']) ?? num(promptDetails?.['cachedTokens'])
  const promptTotal = num(r['prompt_tokens']) ?? num(r['promptTokens'])
    ?? (hitDsh === undefined ? num(r['input_tokens']) ?? num(r['inputTokens']) : undefined)
  const missDirect = num(r['prompt_cache_miss_tokens']) ?? num(r['promptCacheMissTokens'])
    ?? (hitDsh !== undefined ? num(r['inputTokens']) ?? num(r['input_tokens']) : undefined)
  const output = num(r['completion_tokens']) ?? num(r['completionTokens']) ?? num(r['output_tokens']) ?? num(r['outputTokens']) ?? 0
  const reasoning = num(completionDetails?.['reasoning_tokens']) ?? num(completionDetails?.['reasoningTokens'])
    ?? num(r['reasoning_tokens']) ?? num(r['reasoningTokens']) ?? 0
  const cacheRead = hit ?? 0
  const miss = missDirect ?? (promptTotal !== undefined ? Math.max(0, promptTotal - cacheRead) : undefined)
  if (miss === undefined && hit === undefined && output === 0) return undefined
  return { hit: cacheRead, miss: miss ?? 0, output, reasoning }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { hit: a.hit + b.hit, miss: a.miss + b.miss, output: a.output + b.output, reasoning: a.reasoning + b.reasoning }
}

export const ZERO_USAGE: Usage = { hit: 0, miss: 0, output: 0, reasoning: 0 }

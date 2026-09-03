/**
 * Normalize the token-usage shapes seen on dsh session events into hit / miss / output / reasoning.
 * dsh (`TokenUsage`): inputTokens = billed (miss) input, cacheReadTokens = cache-hit input.
 * OpenAI-style: prompt_tokens is the total; hits in prompt_cache_hit_tokens or prompt_tokens_details.cached_tokens.
 */
import type { Usage } from './types.js';
export declare function normalizeUsage(u: unknown): Usage | undefined;
export declare function addUsage(a: Usage, b: Usage): Usage;
export declare const ZERO_USAGE: Usage;

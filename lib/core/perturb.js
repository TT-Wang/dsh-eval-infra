/**
 * Prompt-perturbation variants: semantics-preserving paraphrases of a
 * scenario's prompt list, written to prompts.variants.json for `--perturb`.
 * A paraphrase must keep every requirement, name, path, number and format
 * rule; only the wording changes. The generator prints what it wrote so a
 * human can reject a variant that changed the task.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const PARAPHRASE_SYSTEM = [
    'You rewrite instructions for a software agent so that the meaning is unchanged but the wording differs.',
    'Keep every requirement, file name, path, number, format rule, constraint and order of steps exactly; do not add hints, examples or explanations; do not drop anything.',
    'Change sentence structure and vocabulary; you may reorder clauses when the meaning is unaffected.',
    'Answer with JSON only: {"prompts": ["...", "..."]} with exactly the same number of prompts as given, in the same order.',
].join(' ');
export async function generateVariants(scenario, n, chat, seed = 1) {
    const variants = [];
    const rejected = [];
    let usd = 0;
    for (let k = 0; k < n; k += 1) {
        const res = await chat([
            { role: 'system', content: PARAPHRASE_SYSTEM },
            { role: 'user', content: `Variant ${k + 1} of ${n} (style seed ${seed + k}; make it differ from the earlier variants).\n\nPrompts (JSON):\n${JSON.stringify(scenario.prompts, null, 2)}` },
        ]);
        usd += (res.usage.miss * 0.44 + res.usage.hit * 0.014 + res.usage.output * 1.32) / 1e6;
        let parsed;
        try {
            parsed = JSON.parse(res.text);
        }
        catch {
            rejected.push(`variant ${k + 1}: not JSON`);
            continue;
        }
        const prompts = parsed.prompts;
        if (!Array.isArray(prompts) || prompts.length !== scenario.prompts.length || prompts.some(p => typeof p !== 'string' || p.trim().length === 0)) {
            rejected.push(`variant ${k + 1}: wrong shape`);
            continue;
        }
        const list = prompts.map(p => p.trim());
        if (list.every((p, i) => p === scenario.prompts[i])) {
            rejected.push(`variant ${k + 1}: identical to the original`);
            continue;
        }
        variants.push(list);
    }
    return { variants, usd, rejected };
}
export function writeVariants(scenario, variants) {
    const file = join(scenario.dir, 'prompts.variants.json');
    writeFileSync(file, JSON.stringify(variants, null, 2) + '\n');
    return file;
}

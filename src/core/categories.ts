/**
 * What each scenario category is for. A bucket of scenarios only helps if a
 * reader knows what buying into it measures, so every category carries one line
 * of plain language and the kind of component it discriminates.
 */
export interface CategoryInfo { key: string; title: string; what: string; useFor: string }

export const CATEGORIES: CategoryInfo[] = [
  { key: 'context', title: 'Context', what: 'Long inputs, growing histories and forced compaction: the agent must still find, keep and reuse the facts that matter.', useFor: 'context management, compaction, folding, retrieval and memory of the conversation itself' },
  { key: 'tools', title: 'Tools', what: 'Work that can be done cheaply with the right tool and expensively with the wrong one.', useFor: 'tool sets, tool descriptions, search and indexing plugins' },
  { key: 'coding', title: 'Coding', what: 'Multi-turn engineering: debugging, refactoring and building on what earlier turns produced.', useFor: 'loops, planning, subagents, anything that changes how work is carried across turns' },
  { key: 'prompt', title: 'Prompt', what: 'Rules and output contracts stated once, then honoured for the rest of the task.', useFor: 'system prompts, personas, standing instructions, output validators' },
  { key: 'memory', title: 'Memory', what: 'What survives a fresh runtime process on the same workspace.', useFor: 'memory backends and anything that writes state meant to outlive a session' },
  { key: 'safety', title: 'Safety', what: 'Instructions planted in files and tool results that the agent is meant to report on, not obey.', useFor: 'guard personas, permission presets, injection defences' },
  { key: 'cost', title: 'Cost', what: 'Tasks where the answer is easy and the cheap route is the whole point.', useFor: 'anything claiming to reduce tokens or spend' },
  { key: 'verification', title: 'Verification', what: 'Deliverables the agent must actually check before calling them done.', useFor: 'verification loops, self-checking prompts, done-criteria plugins' },
]

export function categoryInfo(key: string | undefined): CategoryInfo {
  return CATEGORIES.find(c => c.key === key) ?? { key: key ?? 'uncategorised', title: key ?? 'Uncategorised', what: 'No description for this category yet.', useFor: '' }
}

/**
 * The YAML an arm file holds, generated from one chosen change. Kept apart from
 * the editor component so the shapes it writes can be tested without a DOM.
 */
export type Change = 'insert-plugin' | 'disable-row' | 'config-field' | 'model' | 'effort' | 'freeform'

export const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
export const EFFORTS = ['off', 'low', 'high', 'max']

/** One arm file, holding exactly one difference from the baseline. */
export function armYaml(name: string, description: string, change: Change, v: { plugin?: string; row?: string; key?: string; value?: string; model?: string; effort?: string }): string {
  const head = [`name: ${name}`, description.trim() ? `description: ${description.trim()}` : null].filter(Boolean).join('\n')
  const rowId = (v.plugin ?? '').split('/').pop()?.replace(/^dsh-/, '') ?? 'plugin'
  switch (change) {
    case 'insert-plugin':
      return `${head}\npatches:\n  - insert:\n      - id: ${rowId}\n        name: '${v.plugin ?? ''}'\n        # config: {}\n`
    case 'disable-row':
      return `${head}\npatches:\n  - id: ${v.row ?? ''}\n    disabled: true\n`
    case 'config-field':
      return `${head}\npatches:\n  - id: ${v.row ?? ''}\n    config:\n      ${v.key ?? 'key'}: ${v.value ?? ''}\n`
    case 'model':
      return `${head}\nmodel: ${v.model ?? MODELS[0]}\n`
    case 'effort':
      return `${head}\neffort: ${v.effort ?? 'high'}\n`
    default:
      return `${head}\npatches: []\n`
  }
}


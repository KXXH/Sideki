import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContent } from '../skills'

export const useSkillTool = tool({
  description: 'Load a skill by name to get specialized instructions for a task. Use `skill list` in bash to see available skills.',
  inputSchema: z.object({
    name: z.string().describe('Skill name (e.g. "seo-audit")'),
  }),
  execute: async ({ name }) => {
    const content = getSkillContent(name)
    if (!content) throw new Error(`Skill "${name}" not found. Run \`skill list\` in bash to see available skills.`)
    return content
  },
})

import { z } from 'zod'

// Reason: optional for old calls and backend compatibility. This describes one
// invocation, rather than the tool's capabilities, and is never an instruction.
export const toolDescriptionInput = z.string().optional().describe(
  'Write this field FIRST, before other arguments. A short Chinese action phrase explaining this specific call to the user (e.g. 提取商品价格和库存). Describe the intended action, not a successful outcome. Do not include secrets, code, or raw selectors. Keep it under 30 Chinese characters when possible.',
)

export function withoutToolDescription<T extends { description?: string }>(input: T): Omit<T, 'description'> {
  const { description, ...args } = input
  // Reason: display metadata must not reach operational command handlers.
  void description
  return args
}

import deepseek from '../assets/provider-logos/deepseek-color.svg?raw'
import openai from '../assets/provider-logos/openai.svg?raw'
import qwen from '../assets/provider-logos/bailian-color.svg?raw'
import mimo from '../assets/provider-logos/xiaomimimo.svg?raw'
import kimi from '../assets/provider-logos/kimi-color.svg?raw'
import zhipu from '../assets/provider-logos/zhipu-color.svg?raw'

const logos: Record<string, string> = { deepseek, openai, qwen, mimo, kimi, zhipu }

export default function ProviderLogo({ provider }: { provider?: string }) {
  const svg = provider ? logos[provider] : undefined
  // Reason: only trusted, bundled SVGs are inlined so monochrome paths inherit the active theme without remote requests.
  return svg
    ? <span className="provider-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    : <span className="provider-logo provider-logo-custom" aria-hidden="true">↗</span>
}

import type { ApiConfig, ModelParams, ProviderProfile, ReasoningEffort, ApiProtocol } from './types'
import { applyProfile } from './storage'

export interface ModelTemplate {
  apiProtocol?: ApiProtocol
  id: string
  name: string
  mark: string
  tagline: string
  model: string
  label: string
  endpoint: string
  contextWindow: number
  reasoningEffort: ReasoningEffort
  keyUrl: string
  description: string
}

export const MODEL_TEMPLATES: ModelTemplate[] = [
  { id: 'deepseek', name: 'DeepSeek', mark: 'DS', tagline: '日常首选', model: 'deepseek-flash', label: 'DeepSeek Flash', endpoint: 'https://api.deepseek.com', contextWindow: 400000, reasoningEffort: 'high', keyUrl: 'https://platform.deepseek.com/api_keys', description: '日常问答与页面任务，先用这一套。' },
  { id: 'openai', apiProtocol: 'responses', name: 'OpenAI', mark: 'OA', tagline: 'Luna', model: 'gpt-6-luna', label: 'Luna', endpoint: 'https://api.openai.com/v1', contextWindow: 272000, reasoningEffort: 'xhigh', keyUrl: 'https://platform.openai.com/api-keys', description: 'Luna 搭配超高推理强度，作为你的通用助手。' },
  { id: 'qwen', name: '阿里云百炼', mark: '千', tagline: '千问系列', model: 'qwen3.8-max', label: 'Qwen3.8 Max', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', contextWindow: 200000, reasoningEffort: 'medium', keyUrl: 'https://bailian.console.aliyun.com/', description: '连接千问模型，Key 和服务地域需一致。' },
  { id: 'mimo', name: '小米 MiMo', mark: 'Mi', tagline: '低成本之选', model: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash', endpoint: 'https://api.xiaomimimo.com/v1', contextWindow: 200000, reasoningEffort: 'none', keyUrl: 'https://platform.xiaomimimo.com/', description: '支持图片输入，成本低。' },
  { id: 'kimi', name: 'Kimi', mark: 'K', tagline: '月之暗面', model: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', endpoint: 'https://api.moonshot.cn/v1', contextWindow: 200000, reasoningEffort: 'low', keyUrl: 'https://platform.kimi.com/', description: 'K3.1 Pro 价格较高，请留意 API 用量与预算。' },
  { id: 'zhipu', name: '智谱', mark: '智', tagline: 'GLM 系列', model: 'glm-5.3-flash', label: 'GLM-5.3-Flash', endpoint: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 200000, reasoningEffort: 'max', keyUrl: 'https://bigmodel.cn/', description: '连接 GLM 系列。' },
  { id: 'custom', name: 'OpenAI 兼容', mark: '↗', tagline: '自定义地址与模型', model: '', label: '', endpoint: '', contextWindow: 200000, reasoningEffort: 'none', keyUrl: '', description: '' },
]

export const REASONING_LABELS: Record<ReasoningEffort, string> = { '': '未设置', none: '关闭', low: '低 · low', medium: '中等 · medium', high: '高 · high', xhigh: '超高 · xhigh', max: '最高 · max' }
export function reasoningOptions(model: string, protocol: ApiProtocol = 'chat-completions'): ReasoningEffort[] {
  if (/^gpt-6-luna$/i.test(model) && protocol !== 'responses') return ['none']
  if (/^(kimi-k3|glm-5\.3)/i.test(model)) return ['low', 'high', 'max']
  if (/^deepseek-(flash|pro)/i.test(model)) return ['none', 'low', 'high', 'max']
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max']
}
export function formatContext(value: number) { return value >= 1000000 ? `${value / 1000000}M` : `${value / 1000}K` }

export interface ModelService { id: string; name: string; templateId: string; endpoint: string; apiKey: string; profiles: ProviderProfile[] }
export function configProfiles(config: ApiConfig): ProviderProfile[] {
  if (config.profiles?.length) return config.profiles
  if (!config.endpoint && !config.model) return []
  return [{ id: config.activeProfileId || 'legacy-default', name: config.model || 'Default', apiProtocol: config.apiProtocol, endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort, contextWindow: config.contextWindow, supportsImages: config.supportsImages, modelParams: config.modelParams }]
}
export function groupModelServices(config: ApiConfig): ModelService[] {
  const services: ModelService[] = []
  for (const profile of configProfiles(config)) {
    if (!profile.model && !profile.endpoint && !profile.apiKey) continue
    // Reason: legacy profiles stay independent; identical endpoints can represent separate accounts.
    const id = profile.serviceId || profile.id
    let service = services.find(s => s.id === id)
    if (!service) {
      let host = profile.endpoint
      try { host = new URL(profile.endpoint).hostname } catch { /* preserve a legacy endpoint */ }
      service = { id, name: profile.serviceName || profile.name || host || '自定义服务', templateId: profile.templateId || 'custom', endpoint: profile.endpoint, apiKey: profile.apiKey, profiles: [] }
      services.push(service)
    }
    service.profiles.push(profile)
  }
  return services
}

export function addServiceModel(config: ApiConfig, profile: ProviderProfile, select = false): ApiConfig {
  const profiles = configProfiles(config).filter(p => p.model || p.endpoint || p.apiKey)
  if (profiles.some(p => p.id === profile.id)) return updateServiceModel(config, profile)
  const services = groupModelServices(config)
  const serviceExists = services.some(s => s.id === profile.serviceId)
  let added = profile
  if (!serviceExists && profile.serviceName) {
    const names = new Set(services.map(s => s.name))
    let name = profile.serviceName, suffix = 2
    while (names.has(name)) name = `${profile.serviceName} · ${suffix++}`
    added = { ...profile, serviceName: name }
  }
  const next = { ...config, profiles: [...profiles, added] }
  return select || !profiles.length ? applyProfile(next, profile.id) : next
}
export function updateService(config: ApiConfig, service: ModelService, patch: Pick<ModelService, 'name' | 'endpoint' | 'apiKey'>): ApiConfig {
  const ids = new Set(service.profiles.map(p => p.id))
  const next = { ...config, profiles: configProfiles(config).map(p => ids.has(p.id) ? { ...p, serviceId: service.id, serviceName: patch.name, endpoint: patch.endpoint, apiKey: patch.apiKey } : p) }
  return applyProfile(next, next.activeProfileId)
}
export function updateServiceModel(config: ApiConfig, profile: ProviderProfile): ApiConfig {
  const next = { ...config, profiles: configProfiles(config).map(p => p.id === profile.id ? profile : p) }
  return applyProfile(next, next.activeProfileId)
}
export function removeServiceModel(config: ApiConfig, id: string): ApiConfig {
  const profiles = configProfiles(config).filter(p => p.id !== id)
  if (!profiles.length) return { ...config, profiles: [], activeProfileId: '', apiProtocol: 'chat-completions', model: '', endpoint: '', apiKey: '', reasoningEffort: '', supportsImages: true, modelParams: undefined, contextWindow: 200000 }
  return applyProfile({ ...config, profiles }, config.activeProfileId === id ? profiles[0].id : config.activeProfileId)
}
export const MODEL_PARAM_FIELDS: { key: keyof ModelParams; label: string; step: number; min?: number; max?: number }[] = [
  { key: 'temperature', label: 'temperature', step: .1, min: 0, max: 2 }, { key: 'topP', label: 'top_p', step: .05, min: 0, max: 1 }, { key: 'topK', label: 'top_k', step: 1, min: 0 }, { key: 'minP', label: 'min_p', step: .01, min: 0, max: 1 }, { key: 'presencePenalty', label: 'presence_penalty', step: .1, min: -2, max: 2 }, { key: 'repetitionPenalty', label: 'repetition_penalty', step: .1, min: 0 }, { key: 'maxTokens', label: 'max_tokens', step: 256, min: 1 },
]

import { describe, expect, it } from 'vitest'
import { addServiceModel, groupModelServices, removeServiceModel, updateService, updateServiceModel, MODEL_TEMPLATES, reasoningOptions } from '../../src/shared/model-services'
import { DEFAULT_CONFIG } from '../../src/sidepanel/default-config'
import { introKind, ONBOARDING_SEEN_KEY, UPDATE_INTRO_SEEN_KEY } from '../../src/sidepanel/hooks/use-update-intro'
import type { ApiConfig, ProviderProfile } from '../../src/shared/types'
import { applyProfile } from '../../src/shared/storage'

const a: ProviderProfile = { id: 'a', name: 'Original name', endpoint: 'https://example.test/v1', apiKey: 'old-secret', model: 'a', reasoningEffort: 'high', contextWindow: 272000, modelParams: { temperature: .2 } }
const b: ProviderProfile = { ...a, id: 'b', name: 'Other account', apiKey: 'other-secret', contextWindow: 128000 }
const config: ApiConfig = { ...DEFAULT_CONFIG, ...a, activeProfileId: a.id, profiles: [a, b] }

describe('model service compatibility and selection', () => {
  it('leaves legacy profiles, account boundaries, budgets and selection unchanged', () => {
    const services = groupModelServices(config)
    expect(services.map(s => s.name)).toEqual(['Original name', 'Other account'])
    expect(services[0].profiles[0]).toEqual(a)
    expect(groupModelServices({ ...config, profiles: [] })[0].profiles[0]).toMatchObject({ endpoint: a.endpoint, contextWindow: 272000, modelParams: { temperature: .2 } })
    expect(config.profiles[1].contextWindow).toBe(128000)
  })
  it('adds a model to a legacy service without changing the selected model, then updates shared credentials together', () => {
    const nextProfile = { ...a, id: 'new', serviceId: 'a', serviceName: 'My service', model: 'new' }
    const next = addServiceModel(config, nextProfile)
    expect(next.activeProfileId).toBe('a')
    expect(next.model).toBe('a')
    const services = groupModelServices(next)
    expect(services[0].profiles).toHaveLength(2)
    const edited = updateService(next, services[0], { name: 'Renamed', endpoint: 'https://new.test/v1', apiKey: 'new-secret' })
    expect(edited.profiles.filter(p => p.serviceId === 'a')).toHaveLength(2)
    expect(edited.profiles.filter(p => p.serviceId === 'a').every(p => p.apiKey === 'new-secret' && p.serviceName === 'Renamed')).toBe(true)
    expect(edited.endpoint).toBe('https://new.test/v1')
    expect(edited.profiles.find(p => p.id === 'b')).toEqual(b)
  })
  it('distinguishes repeated services and does not duplicate an already saved model', () => {
    const first = { ...a, serviceId: 'one', serviceName: 'DeepSeek' }
    const next = addServiceModel(addServiceModel(DEFAULT_CONFIG, first), { ...first, id: 'new', serviceId: 'two' })
    expect(groupModelServices(next).map(s => s.name)).toEqual(['DeepSeek', 'DeepSeek · 2'])
    expect(addServiceModel(next, first).profiles).toHaveLength(2)
  })

  it('editing an inactive model does not select it; editing the selected one updates its request mirror', () => {
    const edited = updateServiceModel(config, { ...b, contextWindow: 400000, reasoningEffort: 'max' })
    expect(edited.model).toBe('a')
    expect(edited.contextWindow).toBe(272000)
    expect(updateServiceModel(config, { ...a, contextWindow: 400000 }).contextWindow).toBe(400000)
  })
  it('selects the first configured model and clears credentials when the final model is removed', () => {
    expect(addServiceModel(DEFAULT_CONFIG, a).activeProfileId).toBe('a')
    const remaining = removeServiceModel(config, a.id)
    expect(remaining).toMatchObject({ activeProfileId: b.id, apiKey: b.apiKey, contextWindow: 128000 })
    expect(removeServiceModel(remaining, b.id)).toMatchObject({ activeProfileId: '', apiKey: '', model: '', profiles: [] })
  })
  it('uses the agreed template budgets and valid native effort values', () => {
    expect(MODEL_TEMPLATES.find(t => t.id === 'deepseek')).toMatchObject({ contextWindow: 400000, reasoningEffort: 'high' })
    expect(MODEL_TEMPLATES.find(t => t.id === 'openai')).toMatchObject({ contextWindow: 272000, reasoningEffort: 'xhigh', apiProtocol: 'responses' })
    expect(MODEL_TEMPLATES.filter(t => !['openai', 'deepseek'].includes(t.id)).every(t => t.contextWindow === 200000)).toBe(true)
    expect(MODEL_TEMPLATES.find(t => t.id === 'kimi')?.reasoningEffort).toBe('low')
    expect(MODEL_TEMPLATES.find(t => t.id === 'zhipu')?.reasoningEffort).toBe('max')
    expect(MODEL_TEMPLATES.find(t => t.id === 'mimo')?.model).toBe('mimo-v2.6-flash')
    expect(reasoningOptions('glm-5.3-flash')).not.toContain('xhigh')
  })

  it('copies protocol per model, resets a missing legacy protocol, and retains it when editing shared credentials', () => {
    const response = { ...a, apiProtocol: 'responses' as const, serviceId: 's' }
    const legacy = { ...b, serviceId: 's' }
    const selected = applyProfile({ ...config, profiles: [response, legacy] }, 'a')
    expect(selected.apiProtocol).toBe('responses')
    expect(applyProfile(selected, 'b').apiProtocol).toBe('chat-completions')
    const edited = updateService(selected, groupModelServices(selected)[0], { name: 'Renamed', endpoint: a.endpoint, apiKey: 'new' })
    expect(edited.apiProtocol).toBe('responses')
    expect(edited.profiles[1].apiProtocol).toBeUndefined()
    expect(groupModelServices({ ...selected, profiles: [] })[0].profiles[0].apiProtocol).toBe('responses')
    expect(reasoningOptions('gpt-6-luna', 'responses')).toContain('xhigh')
    expect(reasoningOptions('gpt-6-luna')).toEqual(['none'])
  })
})

it('distinguishes first installation from existing users without reclassifying an upgrade as onboarding', () => {
  expect(introKind({})).toBe('onboarding')
  for (const stored of [{ sidekick_config: config }, { sidekick_session_index: [{ id: 'old' }] }, { sidekick_sessions: [{ id: 'old' }] }, { [UPDATE_INTRO_SEEN_KEY]: 'old-release' }, { [ONBOARDING_SEEN_KEY]: true }]) expect(introKind(stored)).toBe('update')
})

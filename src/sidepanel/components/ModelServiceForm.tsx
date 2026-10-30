import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react'
import { Icon } from '@iconify/react'
import { generateText, jsonSchema, tool } from 'ai'
import { iconEye, iconEyeOff, iconChevronDown } from '../../shared/icons'
import { createProvider, sdkReasoningEffort } from '../../shared/ai-provider'
import { MODEL_TEMPLATES, MODEL_PARAM_FIELDS, REASONING_LABELS, reasoningOptions, formatContext, type ModelService } from '../../shared/model-services'
import type { ProviderProfile } from '../../shared/types'
import { DEFAULT_CONFIG } from '../default-config'
import { apiBaseUrl } from '../../shared/api-endpoint'
import { modelServiceError } from './model-service-error'
import ContextWindowPicker from './ContextWindowPicker'
import ProviderLogo from './ProviderLogo'
import './model-services.css'

export type ServiceFormMode = 'service' | 'model' | 'credentials'
interface Props {
  mode?: ServiceFormMode
  service?: ModelService
  profile?: ProviderProfile
  onSave: (profile: ProviderProfile) => Promise<void>
  onBusyChange?: (busy: boolean) => void
  formRef?: Ref<HTMLFormElement>
  hideSubmit?: boolean
  formId?: string
}
function templateProfile(id: string): ProviderProfile {
  const t = MODEL_TEMPLATES.find(t => t.id === id)!
  return { id: crypto.randomUUID(), serviceId: crypto.randomUUID(), serviceName: id === 'custom' ? '' : t.name, templateId: t.id, apiProtocol: t.apiProtocol ?? 'chat-completions', name: t.label, endpoint: t.endpoint, apiKey: '', model: t.model, contextWindow: t.contextWindow, reasoningEffort: t.reasoningEffort, supportsImages: true }
}

export default function ModelServiceForm({ mode = 'service', service, profile, onSave, onBusyChange, formRef, hideSubmit = false, formId }: Props) {
  const [value, setValue] = useState<ProviderProfile>(() => profile ?? (service ? { ...templateProfile(service.templateId), id: crypto.randomUUID(), serviceId: service.id, serviceName: service.name, apiProtocol: service.profiles[0]?.apiProtocol ?? 'chat-completions', endpoint: service.endpoint, apiKey: service.apiKey, name: '', model: '' } : templateProfile('deepseek')))
  const [showKey, setShowKey] = useState(false)
  const [advanced, setAdvanced] = useState(mode !== 'service' || value.templateId === 'custom')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const keyId = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  const template = MODEL_TEMPLATES.find(t => t.id === value.templateId) ?? MODEL_TEMPLATES.at(-1)!
  const set = <K extends keyof ProviderProfile>(key: K, next: ProviderProfile[K]) => { setValue(v => ({ ...v, [key]: next })); setError('') }
  const options = reasoningOptions(value.model, value.apiProtocol)
  const efforts = value.reasoningEffort && !options.includes(value.reasoningEffort) ? [value.reasoningEffort, ...options] : options
  // Reason: legacy profiles have no templateId and must retain custom endpoints without mandatory authentication.
  const isCustom = template.id === 'custom'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (controller.current) return
    let endpoint: URL
    try { endpoint = new URL(value.endpoint.trim()); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error() } catch { setAdvanced(true); setError('请填写有效的 API 地址，如 https://example.com/v1。'); return }
    if (mode !== 'credentials' && !value.reasoningEffort) { setAdvanced(true); setError('请选择推理强度。'); return }
    if (!value.serviceName?.trim()) { setError('请填写服务名称。'); return }
    if (!value.model.trim()) { setAdvanced(true); setError('请填写模型 ID。'); return }
    if (mode !== 'credentials' && (!Number.isInteger(value.contextWindow) || value.contextWindow! < 1)) { setAdvanced(true); setError('上下文预算需要填写正整数。'); return }
    if (!value.apiKey.trim() && !isCustom) { setError('请填写 API Key。'); return }
    const next = { ...value, apiProtocol: value.apiProtocol ?? 'chat-completions', endpoint: apiBaseUrl(endpoint.href), apiKey: value.apiKey.trim(), model: value.model.trim(), name: value.name.trim() || value.model.trim(), serviceName: value.serviceName.trim() }
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); onBusyChange?.(true); setError('')
    let timedOut = false
    let phase: 'verify' | 'save' = 'verify'
    const timer = setTimeout(() => { timedOut = true; abort.abort() }, 20000)
    try {
      // Reason: verify through the selected adapter used by chat; a successful models list alone cannot prove inference access.
      if (!profile || mode !== 'model' || next.apiProtocol !== (profile.apiProtocol ?? 'chat-completions') || next.model !== profile.model) await generateText({ model: createProvider({ ...DEFAULT_CONFIG, ...next, modelParams: undefined }, { enableThinking: !!next.reasoningEffort && next.reasoningEffort !== 'none' }), messages: [{ role: 'user', content: 'Reply with OK.' }], tools: { sidekick_connection_check: tool({ description: 'Connection check only; no browser operation.', inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }) }) }, maxOutputTokens: 128, reasoning: sdkReasoningEffort(next.reasoningEffort), abortSignal: abort.signal, maxRetries: 0 })
      clearTimeout(timer)
      if (abort.signal.aborted) throw new Error('cancelled')
      phase = 'save'
      await onSave(next)
    } catch (e) {
      if (alive.current) {
        setError(timedOut ? '连接超时，请检查地址或稍后重试。' : abort.signal.aborted ? '已取消验证。' : modelServiceError(e, phase, next.apiKey))
      }
    } finally { clearTimeout(timer); controller.current = null; if (alive.current) { setBusy(false); onBusyChange?.(false) } }
  }

  return <form ref={formRef} id={formId} className="model-service-form" onSubmit={submit} aria-busy={busy}>
    <fieldset disabled={busy}>
      {mode === 'service' && <div className="model-template-grid" aria-label="选择 API 服务商">{MODEL_TEMPLATES.map(t => <button key={t.id} type="button" aria-pressed={template.id === t.id} data-template={t.id} onClick={() => { setValue(templateProfile(t.id)); setAdvanced(t.id === 'custom'); setError('') }}><span className="model-template-mark"><ProviderLogo provider={t.id} /></span><span>{t.name}<small>{t.tagline}</small></span><span className="model-template-dot" /></button>)}</div>}
      {mode === 'service' && !isCustom && <div className="model-template-summary"><header><span>Sideki 推荐配置</span><span>官方 API</span></header><strong>{template.label}</strong><p className={template.id === 'kimi' ? 'model-budget-note' : ''}>{template.description}</p><div><span>{formatContext(value.contextWindow!)} 上下文</span><span>{REASONING_LABELS[value.reasoningEffort]}</span></div></div>}
      {mode === 'service' && template.id === 'qwen' && <label>服务地域<span className="model-select"><select aria-label="服务地域" value={value.endpoint.includes('dashscope-intl') ? 'intl' : 'cn'} onChange={e => set('endpoint', e.target.value === 'intl' ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' : template.endpoint)}><option value="cn">中国内地 · 北京</option><option value="intl">新加坡</option></select><Icon icon={iconChevronDown} aria-hidden="true" /></span></label>}
      {(isCustom || mode === 'credentials') && mode !== 'model' && <label>服务名称<input required maxLength={60} value={value.serviceName} placeholder="例如：公司模型服务" onChange={e => set('serviceName', e.target.value)} /></label>}
      {mode !== 'model' && <div className="model-key-block"><div className="model-key-label"><label htmlFor={keyId}>API Key{isCustom && <span>（可选）</span>}</label>{template.keyUrl && <a href={template.keyUrl} target="_blank" rel="noopener noreferrer">获取 Key ↗</a>}</div><div className="model-key-input"><input id={keyId} aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} required={!isCustom} value={value.apiKey} placeholder="粘贴服务商提供的 API Key" onChange={e => set('apiKey', e.target.value)} /><button type="button" aria-label={showKey ? '隐藏 Key' : '显示 Key'} onClick={() => setShowKey(v => !v)}><Icon icon={showKey ? iconEyeOff : iconEye} /></button></div></div>}
      {mode === 'credentials' ? <label>API 地址<input required type="url" aria-label="API 地址" placeholder="https://api.example.com/v1" value={value.endpoint} onChange={e => set('endpoint', e.target.value)} /><span className="model-form-hint">填写服务商提供的基础地址（可能包含 /v1），无需附加 /responses 或 /chat/completions。</span></label> : <>
        <button type="button" className="model-advanced-trigger" aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>{mode === 'model' ? '模型参数' : isCustom ? '连接参数' : '高级参数'}<Icon icon={iconChevronDown} style={{ transform: advanced ? 'rotate(180deg)' : undefined }} /></button>
        <div className="model-advanced-reveal" data-open={advanced}><div><div className="model-advanced-fields">
          {mode !== 'model' && <label>API 地址<input type="url" aria-label="API 地址" placeholder="https://api.example.com/v1" value={value.endpoint} onChange={e => set('endpoint', e.target.value)} /><span className="model-form-hint">填写服务商提供的基础地址（可能包含 /v1），无需附加 /responses 或 /chat/completions。</span></label>}
          {mode === 'model' && <label>显示名称<input aria-label="模型显示名称" value={value.name} placeholder={value.model || '例如：日常助手'} onChange={e => set('name', e.target.value)} /></label>}
          <label>接口格式<span className="model-select"><select aria-label="接口格式" value={value.apiProtocol ?? 'chat-completions'} onChange={e => { const apiProtocol = e.target.value as NonNullable<ProviderProfile['apiProtocol']>; const allowed = reasoningOptions(value.model, apiProtocol); setValue(v => ({ ...v, apiProtocol, reasoningEffort: allowed.includes(v.reasoningEffort) ? v.reasoningEffort : allowed[0] })); setError('') }}><option value="chat-completions">Chat Completions</option><option value="responses">Responses API</option></select><Icon icon={iconChevronDown} aria-hidden="true" /></span></label>
          <label>模型 ID<input aria-label="模型 ID" spellCheck={false} value={value.model} onChange={e => { const model = e.target.value; const allowed = reasoningOptions(model, value.apiProtocol); setValue(v => ({ ...v, model, name: profile ? v.name : model, reasoningEffort: allowed.includes(v.reasoningEffort) ? v.reasoningEffort : allowed[0] })); setError('') }} /></label>
          <div className="model-form-label">上下文预算<ContextWindowPicker value={value.contextWindow!} onChange={n => set('contextWindow', n)} /></div>
          <label>推理强度<span className="model-select"><select aria-label="推理强度" value={value.reasoningEffort} onChange={e => set('reasoningEffort', e.target.value as ProviderProfile['reasoningEffort'])}>{!value.reasoningEffort && <option value="" disabled hidden>选择强度</option>}{efforts.map(v => <option key={v} value={v}>{REASONING_LABELS[v]}</option>)}</select><Icon icon={iconChevronDown} aria-hidden="true" /></span></label>
          <label className="model-images"><input type="checkbox" checked={value.supportsImages !== false} onChange={e => set('supportsImages', e.target.checked)} />支持图片输入</label>
          <p className="model-form-hint">建议使用支持图片输入的模型；推理强度不必设得过高，以提升交互速度。</p>
          <details className="model-decoding"><summary>采样与输出参数</summary><div>{MODEL_PARAM_FIELDS.filter(field => value.apiProtocol !== 'responses' || ['temperature', 'topP', 'maxTokens'].includes(field.key)).map(field => <label key={field.key}>{field.label}<input type="number" step={field.step} min={field.min} max={field.max} placeholder="服务商默认" value={value.modelParams?.[field.key] ?? ''} onChange={e => { const params = { ...value.modelParams }; if (!e.target.value) delete params[field.key]; else params[field.key] = Number(e.target.value); set('modelParams', params) }} /></label>)}</div></details>
        </div></div></div>
      </>}
    </fieldset>
    {error && <p className="model-form-error" role="alert">{error}</p>}
    {busy && <div className="model-verifying" role="status">正在验证连接…<button type="button" onClick={() => controller.current?.abort()}>取消</button></div>}
    {!hideSubmit && <button className="model-primary" type="submit" disabled={busy}>{busy ? '正在验证…' : mode === 'model' && profile ? '保存模型配置' : mode === 'service' ? '验证并添加' : '验证并保存'}</button>}
  </form>
}

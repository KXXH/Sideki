import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { iconPlus, iconChevronDown, iconCog, iconCheck, iconDelete } from '../../shared/icons'
import { applyProfile } from '../../shared/storage'
import { addServiceModel, groupModelServices, updateService, updateServiceModel, removeServiceModel, formatContext, REASONING_LABELS, type ModelService } from '../../shared/model-services'
import type { ApiConfig, ProviderProfile } from '../../shared/types'
import ModelServiceForm, { type ServiceFormMode } from './ModelServiceForm'
import ProviderLogo from './ProviderLogo'
import AppDialog, { DialogAction } from './AppDialog'

export default function ModelServices({ config, onChange }: { config: ApiConfig; onChange: (config: ApiConfig) => Promise<void> }) {
  const services = groupModelServices(config)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: ServiceFormMode; service?: ModelService; profile?: ProviderProfile } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const latest = useRef(config)
  useEffect(() => { latest.current = config }, [config])
  const formId = useId()
  const title = editor?.mode === 'service' ? '添加服务' : editor?.mode === 'credentials' ? '管理连接' : editor?.profile ? '调整模型' : '添加模型'
  async function persist(next: ApiConfig) {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    try { await onChange(next) } catch (e) { setError('保存失败，请重试。'); throw e } finally { savingRef.current = false; setSaving(false) }
  }
  const activeService = services.find(s => s.profiles.some(p => p.id === config.activeProfileId))?.id
  const expandedId = expanded ?? activeService ?? services[0]?.id
  function edit(mode: ServiceFormMode, service?: ModelService, profile?: ProviderProfile) {
    setBusy(false); setEditor({ mode, service, profile }); setError('')
  }
  return <div className="model-services">
    <header className="model-services-heading"><span>{services.length} 个服务 · {services.reduce((sum, s) => sum + s.profiles.length, 0)} 个模型</span><button type="button" onClick={() => edit('service')}><Icon icon={iconPlus} />添加服务</button></header>
    {!services.length && <p className="model-empty">选择服务商模板，粘贴 Key 即可开始。</p>}
    {services.map(service => {
      const open = expandedId === service.id
      return <section className="model-service" key={service.id}>
        <header><span className="model-template-mark"><ProviderLogo provider={service.templateId} /></span><button type="button" className="model-service-toggle" aria-expanded={open} onClick={() => setExpanded(open ? '' : service.id)}><span><strong>{service.name}</strong><small>{service.templateId === 'custom' ? '自定义 API' : '官方 API'} · {service.profiles.length} 个模型</small></span><Icon icon={iconChevronDown} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button><button type="button" className="model-service-manage" aria-label={`管理${service.name}连接`} onClick={() => edit('credentials', service, { ...service.profiles[0], serviceName: service.name, serviceId: service.id })}><Icon icon={iconCog} /></button></header>
        <div className="model-service-reveal" data-open={open}><div><div className="model-service-body">
          <div className="model-service-credentials"><p>{service.endpoint}</p></div>
          <div className="model-service-caption">模型配置</div>
          {service.profiles.map(profile => <div className="model-service-row" key={profile.id}>
            <div><strong>{profile.name || profile.model}</strong><small>{formatContext(profile.contextWindow ?? config.contextWindow)} 上下文 · {REASONING_LABELS[profile.reasoningEffort]}</small></div>
            <button type="button" className="model-use" disabled={saving} aria-pressed={profile.id === config.activeProfileId} aria-label={`${profile.id === config.activeProfileId ? '已选用' : '选用'} ${profile.name || profile.model}`} onClick={() => { if (profile.id !== config.activeProfileId) void persist(applyProfile(latest.current, profile.id)).catch(() => {}) }}>{profile.id === config.activeProfileId && <Icon icon={iconCheck} />}{profile.id === config.activeProfileId ? '已选用' : '选用'}</button>
            <button type="button" className="model-edit" onClick={() => edit('model', service, { ...profile, contextWindow: profile.contextWindow ?? config.contextWindow, serviceName: service.name, serviceId: service.id })}>调整</button>
            <button type="button" className="model-remove" aria-label={`删除 ${profile.name || profile.model}`} onClick={() => { setError(''); setPendingDelete(profile.id) }}><Icon icon={iconDelete} /></button>
          </div>)}
          <button type="button" className="model-add" onClick={() => edit('model', service)}><Icon icon={iconPlus} />添加模型</button>
        </div></div></div>
      </section>
    })}
    {error && !editor && <p role="alert" className="model-form-error">{error}</p>}
    <AppDialog open={!!editor} title={title} placement="bottom" onClose={() => setEditor(null)} dismissible={!busy} footer={<>
      <DialogAction disabled={busy} onClick={() => setEditor(null)}>取消</DialogAction>
      <DialogAction variant="primary" type="submit" form={formId} disabled={busy}>{busy ? '正在验证…' : editor?.mode === 'model' && editor.profile ? '保存模型配置' : editor?.mode === 'service' ? '验证并添加' : editor?.mode === 'model' ? '验证并添加模型' : '验证并保存'}</DialogAction>
    </>}>
      {editor && <ModelServiceForm formId={formId} hideSubmit mode={editor.mode} service={editor.service} profile={editor.profile} onBusyChange={setBusy} onSave={async profile => {
          let next: ApiConfig
          if (editor.mode === 'credentials') next = updateService(latest.current, editor.service!, { name: profile.serviceName!, endpoint: profile.endpoint, apiKey: profile.apiKey })
          else if (editor.mode === 'model' && editor.profile) next = updateServiceModel(latest.current, profile)
          else next = addServiceModel(latest.current, profile)
          await persist(next)
          setExpanded(profile.serviceId || profile.id); setBusy(false); setEditor(null)
        }} />}
    </AppDialog>
    <AppDialog open={!!pendingDelete} title="删除模型" onClose={() => setPendingDelete(null)} dismissible={!saving} footer={<>
      <DialogAction disabled={saving} onClick={() => setPendingDelete(null)}>取消</DialogAction>
      <DialogAction variant="danger" disabled={saving} onClick={() => { if (pendingDelete) void persist(removeServiceModel(latest.current, pendingDelete)).then(() => setPendingDelete(null)).catch(() => {}) }}>{saving ? '正在删除…' : '删除配置'}</DialogAction>
    </>}>
      <p>确定删除「{config.profiles?.find(p => p.id === pendingDelete)?.name || config.profiles?.find(p => p.id === pendingDelete)?.model}」？</p>
      <p className="mt-3 text-xs text-text-secondary">只移除此模型配置，历史会话仍会保留。</p>
      {error && <p role="alert" className="model-form-error">{error}</p>}
    </AppDialog>
  </div>
}

// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import AppDialog, { DialogAction } from '../../src/sidepanel/components/AppDialog'
import { ActionConsentDialog, ProModeWarningDialog } from '../../src/sidepanel/components/ConsentDialogs'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
let root: Root, container: HTMLDivElement
beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false } })
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })
const render = async (element: React.ReactNode) => { await act(async () => root.render(element)) }
const click = async (element: Element) => { await act(async () => (element as HTMLElement).click()) }
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === text)!

it('opens in the native top layer, labels the dialog and keeps actions outside scrolling content', async () => {
  await render(<AppDialog open title="配置模型" placement="bottom" onClose={vi.fn()} footer={<DialogAction>保存</DialogAction>}><input aria-label="名称" /></AppDialog>)
  const dialog = document.querySelector('dialog')!
  expect(dialog.open).toBe(true)
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('配置模型')
  expect(dialog.dataset.placement).toBe('bottom')
  expect(button('保存').closest('.app-dialog-body')).toBeNull()
  expect(button('保存').closest('.app-dialog-footer')).not.toBeNull()
})
it('only dismisses from the mask, close button or Escape, not content clicks', async () => {
  const close = vi.fn()
  await render(<AppDialog open title="提示" onClose={close}><span id="content">说明</span></AppDialog>)
  await click(document.querySelector('#content')!)
  expect(close).not.toHaveBeenCalled()
  await click(document.querySelector('.app-dialog-backdrop')!)
  await click(document.querySelector('.app-dialog-close')!)
  const event = new Event('cancel', { cancelable: true })
  await act(async () => { document.querySelector('dialog')!.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(close).toHaveBeenCalledTimes(3)
})
it('blocks all dismissal paths while saving', async () => {
  const close = vi.fn()
  await render(<AppDialog open title="保存中" dismissible={false} onClose={close}>内容</AppDialog>)
  await click(document.querySelector('.app-dialog-backdrop')!)
  await click(document.querySelector('.app-dialog-close')!)
  await act(async () => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })) })
  expect(close).not.toHaveBeenCalled()
  expect((document.querySelector('.app-dialog-close') as HTMLButtonElement).disabled).toBe(true)
})
it('releases the native modal and restores opener focus on unmount', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus()
  await render(<AppDialog open title="提示" onClose={vi.fn()}>内容</AppDialog>)
  const dialog = document.querySelector('dialog')!
  await render(null)
  expect(dialog.open).toBe(false)
  expect(document.activeElement).toBe(opener)
  opener.remove()
})
it('denies Escape and grants once or persistently only through the corresponding explicit action', async () => {
  const allow = vi.fn(), deny = vi.fn()
  await render(<ActionConsentDialog open action="click" detail="提交表单" origin="https://example.com" onAllow={allow} onDeny={deny} />)
  await act(async () => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })) })
  expect(deny).toHaveBeenCalledOnce(); expect(allow).not.toHaveBeenCalled()
  await click(button('允许本次操作'))
  expect(allow).toHaveBeenLastCalledWith(false)
  await click(button('在 example.com 上不再询问'))
  expect(allow).toHaveBeenLastCalledWith(true)
})
it('cancels Pro activation on dismissal without accepting risk', async () => {
  const accept = vi.fn(), cancel = vi.fn()
  await render(<ProModeWarningDialog open onAccept={accept} onCancel={cancel} />)
  await click(document.querySelector('.app-dialog-backdrop')!)
  expect(cancel).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled()
  await click(button('我理解风险，激活'))
  expect(accept).toHaveBeenCalledOnce()
})

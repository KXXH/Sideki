// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PermissionModeSwitcher from '../../src/sidepanel/components/PermissionModeSwitcher'

vi.mock('@iconify/react', () => ({ Icon: () => null }))
vi.mock('../../src/sidepanel/components/ModelSwitcher', () => ({
  ModelSwitcherTrigger: ({ label, open, ...props }: React.ComponentPropsWithRef<'button'> & { label: string; open: boolean }) => <button {...props} aria-expanded={open}>{label}</button>,
}))
vi.mock('../../src/sidepanel/components/AnimatedPopover', () => ({
  default: ({ open, children, direction, ...props }: React.ComponentPropsWithRef<'div'> & { open: boolean; direction: string }) => open ? <div {...props} data-direction={direction}>{children}</div> : null,
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('shows the current choice and changes the session permission through one callback', async () => {
  const onChange = vi.fn()
  await act(async () => root.render(<PermissionModeSwitcher value="ask" onChange={onChange} />))
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  expect(trigger.textContent).toBe('请求批准')
  await act(async () => trigger.click())
  const choices = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
  expect(choices).toHaveLength(3)
  expect(choices[0].getAttribute('aria-checked')).toBe('true')
  expect(document.activeElement).toBe(choices[0])
  await act(async () => choices[1].click())
  expect(onChange).toHaveBeenCalledExactlyOnceWith('auto')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('supports keyboard navigation and Escape without changing permissions', async () => {
  const onChange = vi.fn()
  await act(async () => root.render(<PermissionModeSwitcher value="auto" onChange={onChange} />))
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement?.textContent).toContain('全部允许')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(onChange).not.toHaveBeenCalled()
})

it('keeps the menu open and reports failed saves without claiming the new mode', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('Synthetic write failure'))
  await act(async () => root.render(<PermissionModeSwitcher value="ask" onChange={onChange} />))
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2].click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('权限保存失败')
  expect(container.querySelector('button')?.textContent).toBe('请求批准')
  expect(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toContain('请求批准')
})

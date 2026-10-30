import { useState, useEffect, useCallback } from 'react'
import type { ElementAttachment } from '../../shared/types'
import { getMyWindowId } from '../App'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function cropScreenshot(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): Promise<string> {
  const img = await loadImage(dataUrl)
  const sx = Math.round(rect.x * dpr)
  const sy = Math.round(rect.y * dpr)
  const sw = Math.round(rect.width * dpr)
  const sh = Math.round(rect.height * dpr)

  let outW = sw, outH = sh
  if (outW > 800) {
    outH = Math.round(outH * (800 / outW))
    outW = 800
  }

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
  return canvas.toDataURL('image/jpeg', 0.8)
}

interface PickerDoneMessage {
  type: 'picker:done'
  rect: { x: number; y: number; width: number; height: number }
  domSnapshot: string
  label: string
  devicePixelRatio: number
  screenshotDataUrl: string
}

export function useElementPicker() {
  const [isPicking, setIsPicking] = useState(false)
  const [attachments, setAttachments] = useState<ElementAttachment[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (message: { type: string; windowId?: number } & Record<string, unknown>): undefined => {
      if (message.windowId && message.windowId !== getMyWindowId()) return undefined
      if (message.type === 'picker:done') {
        const msg = message as unknown as PickerDoneMessage
        cropScreenshot(msg.screenshotDataUrl, msg.rect, msg.devicePixelRatio)
          .then(croppedImage => {
            setAttachments(prev => [...prev, {
              croppedImage,
              domSnapshot: msg.domSnapshot,
              label: msg.label,
            }])
            setIsPicking(false)
          })
          .catch(() => {
            setError('Failed to process screenshot')
            setIsPicking(false)
          })
      }
      if (message.type === 'picker:cancelled') {
        setIsPicking(false)
      }
      if (message.type === 'picker:error') {
        setError(String(message.error ?? 'Cannot pick elements on this page'))
        setIsPicking(false)
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const startPicker = useCallback(async () => {
    setError('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) { setError('No active tab'); return }
      setIsPicking(true)
      const response = await chrome.runtime.sendMessage({ type: 'picker:start', tabId: tab.id })
      if (!response?.success) {
        setError(response?.error ?? 'Cannot pick elements on this page')
        setIsPicking(false)
      }
    } catch {
      setError('Cannot pick elements on this page')
      setIsPicking(false)
    }
  }, [])

  const clearAttachments = useCallback(() => setAttachments([]), [])
  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])
  const clearError = useCallback(() => setError(''), [])

  return { isPicking, attachments, error, startPicker, clearAttachments, removeAttachment, clearError, setAttachments }
}

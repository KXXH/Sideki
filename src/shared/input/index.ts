// Reason: single entry point for the background and sidepanel sides. Everything
// re-exported here is pure — no chrome or DOM references anywhere in this
// directory, which is what keeps the engine testable under vitest's node
// environment and safe to import statically from the service worker.

export * from './types'
export * from './easing'
export * from './hover-chain'
export * from './plan-mouse'
export * from './plan-keyboard'
export * from './cdp'
export * from './cues'
export * from './observe'
export * from './overlay-attr'
export * from './visibility'

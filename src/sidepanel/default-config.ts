import type { ApiConfig, ProviderProfile } from '../shared/types'
import { DEFAULT_THEME_ID } from '../shared/themes'

const defaultProfile: ProviderProfile = { id: crypto.randomUUID(), name: 'Default', endpoint: '', apiKey: '', model: '', reasoningEffort: '' }

// Reason: choosing a theme before connecting a model must create the same complete config as Settings.
export const DEFAULT_CONFIG: ApiConfig = {
  endpoint: "",
  apiKey: "",
  model: "",
  contextWindow: 200000,
  systemPrompt: "",
  reasoningEffort: "",
  securityLevel: "strict" as const,
  maxToolRounds: 10,
  yoloMode: false,
  proModeAccepted: false,
  devMode: false,
  accentColor: DEFAULT_THEME_ID,
  colorMode: "system",
  fontFamily: "sans",
  fontSize: "default",
  pageLockIndicator: true,
  aiPointer: true,
  largeFileUploads: true,
  notifyOnComplete: true,
  collapseSteps: true,
  labAutoCompress: true,
  labAsyncScript: true,
  labInputEngine: true,
  labBackendCompat: true,
  labKernelHost: "offscreen",
  activeProfileId: defaultProfile.id,
  profiles: [defaultProfile],
};

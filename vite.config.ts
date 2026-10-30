import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

const buildHash = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()
const aiSdkVersion = (() => {
  try { return JSON.parse(readFileSync('./node_modules/ai/package.json', 'utf8')).version } catch { return '?' }
})()
const justBashVersion = (() => {
  try { return JSON.parse(readFileSync('./node_modules/just-bash/package.json', 'utf8')).version } catch { return '?' }
})()

// Reason: Vite injects an empty module entry into the second sandbox HTML input.
// The sandbox CSP allows inline scripts but not extension-served modules, so the
// tag would only produce a CSP violation — strip it and its empty chunk.
function stripSandboxModuleEntry(): Plugin {
  return {
    name: 'sidekick:strip-sandbox-module-entry',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'asset' && /^src\/viz\/sandbox(-online)?\.html$/.test(fileName)) {
          output.source = String(output.source).replace(/[ \t]*<script[^>]*type="module"[^>]*><\/script>\n?/g, '')
        }
      }
      // Reason: these entries are pure HTML shells whose CSP forbids module
      // scripts, so any JS chunk Vite creates for them is dead output.
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && /^assets\/(sandbox(\.html)?|sandboxOnline)-[^/]+\.js$/.test(fileName)) {
          delete bundle[fileName]
        }
      }
    },
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_HASH__: JSON.stringify(buildHash),
    __AI_SDK_VERSION__: JSON.stringify(aiSdkVersion),
    __JUST_BASH_VERSION__: JSON.stringify(justBashVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
    stripSandboxModuleEntry(),
  ],
  build: {
    // Reason: local previews must not replace the installed standalone extension with dev-server loaders.
    outDir: command === 'serve' ? 'dist-dev' : 'dist',
    // Reason: dynamic-import-vars skips node_modules by default, so microlighter's
    // `import(`./grammars/${lang}.js`)` ships unexpanded and 404s at runtime. The
    // library swallows that in a catch, so the only symptom is silently no colors.
    dynamicImportVarsOptions: {
      exclude: [/node_modules\/(?!microlighter)/],
    },
    rollupOptions: {
      input: {
        preview: resolve(__dirname, 'src/preview/index.html'),
        sandbox: resolve(__dirname, 'src/viz/sandbox.html'),
        sandboxOnline: resolve(__dirname, 'src/viz/sandbox-online.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        offscreen: resolve(__dirname, 'src/offscreen/index.html'),
        reader: resolve(__dirname, 'src/reader/index.html'),
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    cors: true,
    hmr: {
      port: 5174,
    },
  },
}))

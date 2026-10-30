// Reason: the pointer markup is a string constant inside the service worker, so
// there is no way to look at it without loading the whole extension. This
// generates a standalone preview from that same constant — read from source, not
// duplicated — so the glyphs can be reviewed on both backgrounds with the
// hotspot marked. Regenerate after editing AI_POINTER_MARKUP.
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const src = fs.readFileSync(path.join(root, 'src/background/ai-pointer.ts'), 'utf8')

const m = src.match(/export const AI_POINTER_MARKUP = `([\s\S]*?)`\r?\n/)
if (!m) { console.error('AI_POINTER_MARKUP not found'); process.exit(1) }
const markup = m[1]

const shapes = [...markup.matchAll(/<svg class="(\w+)"/g)].map(s => s[1])
if (shapes.length === 0) { console.error('no glyphs found'); process.exit(1) }

const slot = s =>
  '<div class="slot"><div class="dot"></div>'
  + '<div class="host" data-shape="' + s + '"></div>'
  + '<span class="cap">' + s + '</span></div>'

const pane = t =>
  '<div class="pane ' + t + '"><h2>' + t + ' 背景</h2>'
  + shapes.map(slot).join('') + '</div>'

const html = `<!DOCTYPE html>
<html lang="zh"><meta charset="utf-8"><title>AI 指针预览</title>
<style>
  body { font: 14px/1.5 system-ui; margin: 0; display: grid; grid-template-columns: 1fr 1fr; }
  .bar { grid-column: 1/-1; padding: 12px 24px; background: #eef1f5; color: #111;
         display: flex; gap: 20px; align-items: center; font-size: 13px; }
  .pane { padding: 24px; }
  .light { background: #fff; color: #111; }
  .dark  { background: #15171b; color: #eee; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 0 0 14px; }
  .slot { position: relative; height: 170px; margin-bottom: 10px;
          border: 1px dashed currentColor; border-radius: 8px; }
  .cap { position: absolute; bottom: 6px; left: 8px; font: 11px ui-monospace, Menlo; opacity: .5; }
  /* Reason: the magenta dot is the event coordinate. A correct hotspot puts the
     glyph's tip exactly on it — that is the thing this page exists to check. */
  .dot { position: absolute; left: 80px; top: 80px; width: 5px; height: 5px;
         margin: -2.5px 0 0 -2.5px; border-radius: 50%; background: #f0f; z-index: 9; }
  .host { position: absolute; inset: 0; }
  .host.zoom { transform: scale(4); transform-origin: 80px 80px; }
</style>
<div class="bar">
  <b style="color:#c0f">洋红点 = 事件坐标，glyph 尖端必须压在它上面</b>
  <label><input type="checkbox" id="press"> 按下状态</label>
  <label><input type="checkbox" id="zoom" checked> 4× 放大</label>
</div>
${['light', 'dark'].map(pane).join('')}
<script>
const MARKUP = ${JSON.stringify(markup)};
const hosts = [...document.querySelectorAll('.host')];
for (const host of hosts) {
  host.attachShadow({ mode: 'open' }).innerHTML = MARKUP;
  const p = host.shadowRoot.querySelector('.p');
  p.dataset.on = '1';
  p.dataset.shape = host.dataset.shape;
  p.style.transform = 'translate3d(80px, 80px, 0)';
}
function sync() {
  for (const host of hosts) {
    host.shadowRoot.querySelector('.p').dataset.press = press.checked ? '1' : '0';
    host.classList.toggle('zoom', zoom.checked);
  }
}
press.onchange = sync; zoom.onchange = sync; sync();
</${''}script>
`

const out = path.join(root, 'tests/fixtures/pointer-preview.html')
fs.writeFileSync(out, html)
console.log('shapes:', shapes.join(', '))
console.log('written:', out, html.length, 'bytes')

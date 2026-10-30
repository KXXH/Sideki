#!/usr/bin/env node
const http = require('http')
const { WebSocketServer } = require('ws')

const PORT = parseInt(process.env.BRIDGE_PORT || '9111', 10)
const MAX_EVENTS = 200

let client = null
const eventBuffer = []

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/cmd') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      if (client && client.readyState === 1) {
        client.send(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"No Sideki connection"}')
      }
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const since = parseInt(url.searchParams.get('since') || '0', 10)
    const filtered = eventBuffer.filter(e => e._ts > since)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(filtered))
    return
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      connected: client !== null && client.readyState === 1,
      events: eventBuffer.length,
      uptime: Math.floor(process.uptime()),
    }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  if (client) {
    client.close(1000, 'replaced')
  }
  client = ws
  process.stderr.write(`[bridge] Sideki connected\n`)

  ws.on('message', (data) => {
    const text = data.toString()
    // Print to stdout for Claude Code Monitor
    console.log(text)

    // Buffer for GET /events
    try {
      const parsed = JSON.parse(text)
      parsed._ts = Date.now()
      eventBuffer.push(parsed)
      if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift()
    } catch {
      eventBuffer.push({ raw: text, _ts: Date.now() })
      if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift()
    }
  })

  ws.on('close', () => {
    if (client === ws) client = null
    process.stderr.write(`[bridge] Sideki disconnected\n`)
  })

  ws.on('error', (err) => {
    process.stderr.write(`[bridge] WS error: ${err.message}\n`)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[bridge] Listening on 127.0.0.1:${PORT}\n`)
  process.stderr.write(`[bridge] WS: ws://127.0.0.1:${PORT}/ws\n`)
  process.stderr.write(`[bridge] HTTP: http://127.0.0.1:${PORT}/cmd (POST), /events (GET), /status (GET)\n`)
})

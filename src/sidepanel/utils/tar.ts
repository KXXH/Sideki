export interface TarEntry {
  path: string
  content: string
}

export async function createTarGz(entries: TarEntry[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    const data = encoder.encode(entry.content)
    const header = createTarHeader(entry.path, data.length)
    blocks.push(header)
    blocks.push(data)
    // Pad to 512-byte boundary
    const remainder = data.length % 512
    if (remainder > 0) blocks.push(new Uint8Array(512 - remainder))
  }

  // Two 512-byte zero blocks = EOF
  blocks.push(new Uint8Array(1024))

  const tarData = concatBuffers(blocks)
  return gzipCompress(tarData)
}

function createTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512)
  writeString(header, 0, path, 100)
  writeString(header, 100, '0000644\0', 8)          // mode
  writeString(header, 108, '0001000\0', 8)          // uid
  writeString(header, 116, '0001000\0', 8)          // gid
  writeOctal(header, 124, size, 12)                 // size
  writeOctal(header, 136, Math.floor(Date.now() / 1000), 12) // mtime
  writeString(header, 156, '0', 1)                  // typeflag: regular file
  writeString(header, 257, 'ustar\0', 6)            // magic
  writeString(header, 263, '00', 2)                 // version

  // Compute checksum (sum of all bytes, treating checksum field as spaces)
  writeString(header, 148, '        ', 8)
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += header[i]
  writeOctal(header, 148, checksum, 7)
  header[155] = 0x20 // trailing space

  return header
}

function writeString(buf: Uint8Array, offset: number, str: string, len: number): void {
  for (let i = 0; i < Math.min(str.length, len); i++) {
    buf[offset + i] = str.charCodeAt(i)
  }
}

function writeOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
  const str = value.toString(8).padStart(len - 1, '0')
  writeString(buf, offset, str + '\0', len)
}

function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const buf of buffers) {
    result.set(buf, offset)
    offset += buf.length
  }
  return result
}

async function gzipCompress(data: Uint8Array): Promise<Blob> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

export async function parseTarGz(blob: Blob): Promise<TarEntry[]> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  const buf = new Uint8Array(await new Response(stream).arrayBuffer())
  const decoder = new TextDecoder()
  const entries: TarEntry[] = []
  let offset = 0

  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512)
    // Reason: two consecutive zero blocks = tar EOF
    if (header.every(b => b === 0)) break

    const path = decoder.decode(header.slice(0, 100)).replace(/\0+$/, '')
    const sizeStr = decoder.decode(header.slice(124, 136)).replace(/\0+$/, '')
    const size = parseInt(sizeStr, 8) || 0
    const typeflag = header[156]

    offset += 512

    if (typeflag === 53 || path.endsWith('/')) {
      // Directory entry — skip data blocks
      offset += Math.ceil(size / 512) * 512
      continue
    }

    const content = decoder.decode(buf.slice(offset, offset + size))
    entries.push({ path, content })
    offset += Math.ceil(size / 512) * 512
  }

  return entries
}

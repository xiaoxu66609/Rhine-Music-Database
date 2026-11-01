// 网易云 .ncm 容器解密（算法参考 magic-akari/ncmc MIT，与 ncmdump 系格式一致）。
import { createDecipheriv } from 'node:crypto'
import { readUInt32LE } from './bytes'
import { sniffAudio, type QmcAudioExt } from './decrypt'

const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex')

export interface NcmMeta {
  musicId?: number
  musicName?: string
  artist?: string
  album?: string
  format?: string
  albumPic?: string
  duration?: number
}

export interface NcmDecryptResult {
  audio: Uint8Array
  ext: QmcAudioExt | string
  meta?: NcmMeta
  cover?: { data: Uint8Array; mime: string }
}

export interface NcmError extends Error {
  kind: 'format' | 'key' | 'cipher'
}

function ncmError(kind: NcmError['kind'], message: string): NcmError {
  const e = new Error(message) as NcmError
  e.kind = kind
  return e
}

function aesEcbDecrypt(key: Buffer, data: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 密钥段：逐字节 XOR 100 后 AES-ECB(CORE_KEY) */
export function decryptNcmKeyBlock(data: Uint8Array): Uint8Array {
  const copy = Buffer.from(data)
  for (let index = 0; index < copy.length; index += 1) {
    copy[index] ^= 100
  }
  const plain = aesEcbDecrypt(CORE_KEY, copy)
  if (plain.length < 17 || plain.subarray(0, 17).toString('utf8') !== 'neteasecloudmusic') {
    throw ncmError('key', 'NCM 密钥段无效')
  }
  return plain.subarray(17)
}

/** 元数据段：AES-ECB(META_KEY)，输入为 comment 里 base64 解包后的字节 */
export function decryptNcmMetaBlock(data: Uint8Array): Uint8Array {
  const plain = aesEcbDecrypt(META_KEY, data)
  if (plain.length < 6 || plain.subarray(0, 6).toString('utf8') !== 'music:') {
    throw ncmError('format', 'NCM 元数据无效')
  }
  return plain.subarray(6)
}

class NcmRc4 {
  private readonly stream: Uint8Array
  private index = 0

  constructor(key: Uint8Array) {
    this.stream = NcmRc4.prga(NcmRc4.ksa(key))
  }

  private static ksa(key: Uint8Array): Uint8Array {
    const state = new Uint8Array(256)
    for (let index = 0; index < 256; index += 1) {
      state[index] = index
    }
    let j = 0
    for (let index = 0; index < 256; index += 1) {
      j = (j + state[index] + key[index % key.length]) & 0xff
      const tmp = state[index]
      state[index] = state[j]
      state[j] = tmp
    }
    return state
  }

  private static prga(state: Uint8Array): Uint8Array {
    const out = new Uint8Array(256)
    for (let index = 0; index < 256; index += 1) {
      const key1 = (index + 1) & 0xff
      const key2 = (key1 + state[key1]) & 0xff
      const at = (state[key1] + state[key2]) & 0xff
      out[index] = state[at]
    }
    return out
  }

  decrypt(buf: Uint8Array): void {
    for (let index = 0; index < buf.length; index += 1) {
      buf[index] ^= this.stream[this.index % 256]
      this.index += 1
    }
  }
}

function readLen(buf: Buffer, pos: number): { value: number; next: number } {
  if (pos + 4 > buf.length) {
    throw ncmError('format', 'NCM 文件过短')
  }
  return { value: readUInt32LE(buf, pos), next: pos + 4 }
}

function readFrame(buf: Buffer, pos: number): { data: Buffer; next: number } {
  const { value: length, next } = readLen(buf, pos)
  if (length === 0) {
    return { data: Buffer.alloc(0), next }
  }
  const end = next + length
  if (end > buf.length) {
    throw ncmError('format', 'NCM 帧长度超出文件')
  }
  return { data: buf.subarray(next, end), next: end }
}

function sniffImageMime(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50) {
    return 'image/png'
  }
  return 'image/jpeg'
}

function extFromMeta(format: string | undefined, header: Uint8Array): QmcAudioExt | string {
  const normalized = String(format || '').toLowerCase()
  if (normalized === 'flac' || normalized === 'mp3' || normalized === 'm4a' || normalized === 'ogg') {
    return normalized
  }
  return sniffAudio(header) || 'mp3'
}

export function parseNcmMetaJson(raw: Uint8Array): NcmMeta | undefined {
  try {
    const json = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>
    const artists = Array.isArray(json.artist) ? json.artist : []
    const names = artists
      .map((entry) => (Array.isArray(entry) ? String(entry[0] || '') : ''))
      .filter(Boolean)
    return {
      musicId: typeof json.musicId === 'number' ? json.musicId : Number(json.musicId) || undefined,
      musicName: typeof json.musicName === 'string' ? json.musicName : undefined,
      artist: names.join(' / ') || undefined,
      album: typeof json.album === 'string' ? json.album : undefined,
      format: typeof json.format === 'string' ? json.format : undefined,
      albumPic: typeof json.albumPic === 'string' ? json.albumPic : undefined,
      duration: typeof json.duration === 'number' ? json.duration : undefined,
    }
  } catch {
    return undefined
  }
}

/** 解密整个 .ncm 文件 */
export function decryptNcmFile(file: Uint8Array): NcmDecryptResult {
  const buffer = Buffer.from(file)
  if (buffer.length < 10 || buffer.toString('ascii', 0, 8) !== 'CTENFDAM') {
    throw ncmError('format', '不是有效的 NCM 文件（缺少 CTENFDAM 头）')
  }
  let pos = 10

  const keyFrame = readFrame(buffer, pos)
  pos = keyFrame.next
  const rc4Key = decryptNcmKeyBlock(keyFrame.data)

  const commentFrame = readFrame(buffer, pos)
  pos = commentFrame.next
  let metaRaw: Uint8Array | undefined
  if (commentFrame.data.length > 0) {
    const comment = Buffer.from(commentFrame.data)
    for (let index = 0; index < comment.length; index += 1) {
      comment[index] ^= 99
    }
    const prefix = "163 key(Don't modify):"
    if (comment.length < prefix.length || comment.toString('utf8', 0, prefix.length) !== prefix) {
      throw ncmError('format', 'NCM comment 段无效')
    }
    const encoded = comment.toString('utf8', prefix.length)
    const packed = Buffer.from(encoded, 'base64')
    metaRaw = decryptNcmMetaBlock(packed)
  }

  pos += 5
  const { value: imageOffset, next: afterOffset } = readLen(buffer, pos)
  pos = afterOffset
  const imageFrame = readFrame(buffer, pos)
  pos = imageFrame.next
  if (imageOffset > imageFrame.data.length) {
    pos += imageOffset - imageFrame.data.length
  }
  if (pos > buffer.length) {
    throw ncmError('format', 'NCM 封面偏移非法')
  }

  const audioEncrypted = buffer.subarray(pos)
  if (audioEncrypted.length < 12) {
    throw ncmError('format', 'NCM 音频段过短')
  }
  const rc4 = new NcmRc4(rc4Key)
  const head = Uint8Array.from(audioEncrypted.subarray(0, 12))
  rc4.decrypt(head)
  const ext = extFromMeta(parseNcmMetaJson(metaRaw || new Uint8Array())?.format, head)
  if (!sniffAudio(head) && ext === 'mp3') {
    throw ncmError('cipher', '无法识别解密后的音频格式')
  }

  const audio = Uint8Array.from(audioEncrypted.subarray(12))
  rc4.decrypt(audio)
  const full = new Uint8Array(head.length + audio.length)
  full.set(head, 0)
  full.set(audio, head.length)

  const meta = metaRaw ? parseNcmMetaJson(metaRaw) : undefined
  let cover: NcmDecryptResult['cover']
  if (imageFrame.data.length > 0) {
    cover = { data: Uint8Array.from(imageFrame.data), mime: sniffImageMime(imageFrame.data) }
  }

  return { audio: full, ext, meta, cover }
}

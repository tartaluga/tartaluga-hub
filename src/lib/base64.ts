// Contents API передаёт файлы в base64. Встроенные btoa/atob работают только
// с Latin-1 и ломаются на кириллице, поэтому идём через байты UTF-8 (ADR-002).

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  // GitHub разбивает base64 переводами строк каждые 60 символов.
  const binary = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeText(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

export function decodeText(b64: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(b64))
}

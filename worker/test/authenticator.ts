// Программный ключ доступа для тестов: настоящий ES256-ключ, настоящие authenticatorData и подписи.
// Сервер проверяет его ответы той же библиотекой и той же криптографией, что и ответы телефона.
import { encodeCBOR } from '@levischuck/tiny-cbor'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest()

export interface SoftAuthenticatorOptions {
  rpId: string
  origin: string
  userVerified?: boolean
  counter?: number // 0 — как у синхронизируемых ключей (Google Password Manager)
}

export class SoftAuthenticator {
  readonly id = b64url(randomBytes(16))
  private readonly key: KeyObject
  private readonly publicJwk: { x: string; y: string }
  counter: number
  userVerified: boolean
  rpId: string
  origin: string

  constructor(opts: SoftAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.key = privateKey
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this.counter = opts.counter ?? 0
    this.userVerified = opts.userVerified ?? true
    this.rpId = opts.rpId
    this.origin = opts.origin
  }

  private authData(attested: boolean): Buffer {
    const flags = 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0)
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.counter)
    const parts = [sha256(this.rpId), Buffer.from([flags]), count]
    if (attested) {
      const idBytes = Buffer.from(this.id, 'base64url')
      const len = Buffer.alloc(2)
      len.writeUInt16BE(idBytes.length)
      const cose = encodeCBOR(
        new Map<number, Uint8Array | number>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, Buffer.from(this.publicJwk.x, 'base64url')],
          [-3, Buffer.from(this.publicJwk.y, 'base64url')],
        ]),
      )
      parts.push(Buffer.alloc(16), len, idBytes, Buffer.from(cose))
    }
    return Buffer.concat(parts)
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  /** Ответ navigator.credentials.create() в формате JSON, как его шлёт @simplewebauthn/browser. */
  register(challenge: string) {
    const attestationObject = encodeCBOR(
      new Map<string, string | Uint8Array | Map<string, never>>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(true)],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  /** Ответ navigator.credentials.get(). */
  login(challenge: string) {
    if (this.counter > 0) this.counter++
    const authData = this.authData(false)
    const clientData = this.clientData('webauthn.get', challenge)
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.key)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(randomBytes(16)),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}

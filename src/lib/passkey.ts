// Ключ доступа в браузере: отпечаток, Windows Hello, телефон рядом (ADR-007).
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { api, ApiError } from './api'

export const passkeysSupported = () => browserSupportsWebAuthn()

/** Войти ключом. Уже вошедшему — «свежий вход»: сервер выдаёт новую сессию. */
export async function signInWithPasskey(): Promise<void> {
  const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/options', { method: 'POST' })
  const response = await startAuthentication({ optionsJSON: options })
  await api('/api/auth/passkey', { method: 'POST', body: { response } })
}

/** Добавить ключ этого устройства. Сервер требует свежий вход (5 минут). */
export async function addPasskey(name?: string): Promise<void> {
  const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/passkeys/register/options', { method: 'POST' })
  const response = await startRegistration({ optionsJSON: options })
  await api('/api/passkeys/register', { method: 'POST', body: { response, ...(name ? { name } : {}) } })
}

/** Понятный текст ошибки ключа. null — пользователь сам отменил, сообщать нечего. */
export function passkeyErrorText(e: unknown): string | null {
  if (e instanceof ApiError) return e.message
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'Ключ этого устройства уже добавлен.'
    if (e.code === 'ERROR_CEREMONY_ABORTED') return null
    if (e.code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT') return 'Устройство не умеет проверять отпечаток или PIN.'
  }
  if (e instanceof Error && e.name === 'NotAllowedError') return null // отмена или истёк таймаут
  return 'Ключ не сработал. Попробуй ещё раз или войди через GitHub.'
}

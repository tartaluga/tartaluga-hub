import { describe, expect, it } from 'vitest'
import { WebAuthnError } from '@simplewebauthn/browser'
import { ApiError } from './api'
import { passkeySignInErrorText, STALE_KEY_HINT } from './passkey'

const aborted = () => new WebAuthnError({ message: 'x', code: 'ERROR_CEREMONY_ABORTED', cause: new Error('x') })
const notAllowed = () => Object.assign(new Error('x'), { name: 'NotAllowedError' })

describe('passkeySignInErrorText: подсказка про ключ, удалённый из менеджера паролей', () => {
  it('отмена WebAuthn — не молчим, а подсказываем', () => {
    for (const e of [aborted(), notAllowed()]) {
      const text = passkeySignInErrorText(e)
      expect(text).toBe(`Вход по ключу не состоялся. ${STALE_KEY_HINT}`)
    }
  })

  it('прочая ошибка WebAuthn и отказ сервера — текст ошибки плюс подсказка', () => {
    expect(passkeySignInErrorText(new Error('boom'))).toBe(`Ключ не сработал. Попробуй ещё раз или войди через GitHub. ${STALE_KEY_HINT}`)
    expect(passkeySignInErrorText(new ApiError(401, 'unauthorized', 'Ключ не подошёл'))).toBe(`Ключ не подошёл ${STALE_KEY_HINT}`)
  })

  it('нет сети, лимит и сбой сервера — без подсказки про ключ', () => {
    expect(passkeySignInErrorText(new ApiError(0, 'network', 'Нет связи с сервером хаба'))).toBe('Нет связи с сервером хаба')
    expect(passkeySignInErrorText(new ApiError(429, 'rate_limited', 'Слишком часто'))).toBe('Слишком часто')
    expect(passkeySignInErrorText(new ApiError(503, 'unavailable', 'Сервер недоступен'))).toBe('Сервер недоступен')
  })

  it('подсказка — про менеджер паролей и повторное добавление', () => {
    expect(STALE_KEY_HINT).toContain('менеджера паролей')
    expect(STALE_KEY_HINT).toContain('добавь заново')
  })
})

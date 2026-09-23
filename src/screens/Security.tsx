// «Ключи и входы» (ADR-007): ключи доступа, где выполнен вход, журнал безопасности.
// Добавление и удаление ключа и «Выйти везде» требуют свежего входа — сервер скажет fresh_login_required.
import { useCallback, useEffect, useState } from 'react'
import { DeviceMobile, Fingerprint, GithubLogo, Key, SignOut, Trash } from '@phosphor-icons/react'
import { useSession } from '../app/session'
import {
  ApiError,
  deletePasskey,
  GITHUB_LOGIN_URL,
  listPasskeys,
  listSessions,
  logoutAll,
  markSecuritySeen,
  securityLog,
  type Passkey,
  type SecurityEvent,
  type SessionInfo,
} from '../lib/api'
import { addPasskey, passkeyErrorText, passkeysSupported, signInWithPasskey } from '../lib/passkey'
import { wipeDevice } from '../lib/localdb'
import css from './Security.module.css'

const when = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const how = (method: string) => (method === 'passkey' ? 'по ключу' : method === 'github' ? 'через GitHub' : '')

const EVENTS: Record<string, (e: SecurityEvent) => string> = {
  login: (e) => `Вход ${how(e.method)}`,
  login_denied: () => 'Отказ: вход чужим аккаунтом GitHub',
  logout: () => 'Выход',
  logout_all: () => 'Выход на всех устройствах',
  passkey_added: (e) => `Добавлен ключ «${e.detail}»`,
  passkey_removed: (e) => `Удалён ключ «${e.detail}»`,
  passkey_failed: () => 'Неудачная попытка входа по ключу',
}
const WARN = new Set(['login_denied', 'passkey_failed', 'passkey_removed', 'logout_all'])

interface Data {
  passkeys: Passkey[]
  sessions: SessionInfo[]
  events: SecurityEvent[]
}

export function Security() {
  const me = useSession((s) => s.me)
  const signedIn = useSession((s) => s.signedIn)
  const signOut = useSession((s) => s.signOut)
  const refreshMe = useSession((s) => s.refreshMe)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needFresh, setNeedFresh] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [p, s, l] = await Promise.all([listPasskeys(), listSessions(), securityLog()])
      setData({ passkeys: p.passkeys, sessions: s.sessions, events: l.events })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Владелец открыл журнал — плашка о новых событиях больше не нужна.
  useEffect(() => {
    if (me && me.unseenSecurityEvents > 0) void markSecuritySeen().then(refreshMe, () => undefined)
  }, [me, refreshMe])

  /** Выполнить действие; если сервер просит свежий вход — подтвердить ключом и повторить. */
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNeedFresh(false)
    try {
      try {
        await action()
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'fresh_login_required')) throw e
        if (!data?.passkeys.length || !passkeysSupported()) {
          setNeedFresh(true)
          return
        }
        await signInWithPasskey()
        await signedIn()
        await action()
      }
      await load()
    } catch (e) {
      const text = passkeyErrorText(e)
      if (text) setError(text)
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      await addPasskey()
    })
  const remove = (p: Passkey) => {
    const ok = window.confirm(
      `Удалить ключ «${p.name}»?\n\nЕсли ключ хранится в Google Password Manager или другом менеджере паролей, он перестанет работать на всех устройствах сразу.`,
    )
    if (ok) void run(() => deletePasskey(p.id).then(() => undefined))
  }
  const everywhere = () => {
    if (!window.confirm('Выйти на всех устройствах, включая это? Войти снова можно по ключу или через GitHub.')) return
    void run(async () => {
      await logoutAll()
      await wipeDevice().catch(() => undefined)
      await signOut()
    })
  }

  const firstKey = data && data.passkeys.length === 0

  return (
    <section className={css.page}>
      <div className="label">Безопасность</div>
      <h1 className={css.title}>Ключи и входы</h1>

      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      {needFresh && (
        <div className={css.notice} role="alert">
          <p>Для этого нужно подтвердить вход ещё раз. Ключей пока нет, поэтому — через GitHub. После возврата повтори действие.</p>
          <a className={css.button} href={GITHUB_LOGIN_URL}>
            <GithubLogo size={18} aria-hidden /> Подтвердить через GitHub
          </a>
        </div>
      )}

      <div className={css.block}>
        <div className={css.blockHead}>
          <h2 className={css.h2}>
            <Key size={20} aria-hidden /> Ключи доступа
          </h2>
          {passkeysSupported() && (
            <button type="button" className={css.button} onClick={() => void add()} disabled={busy}>
              <Fingerprint size={18} aria-hidden /> Добавить ключ
            </button>
          )}
        </div>
        {firstKey && (
          <p className={css.muted}>
            Ключей ещё нет. Добавь ключ на каждом устройстве — дальше вход будет по отпечатку или Windows Hello, без GitHub.
          </p>
        )}
        <ul className={css.list}>
          {data?.passkeys.map((p) => (
            <li key={p.id} className={css.row}>
              <div>
                <div>{p.name}</div>
                <div className={css.meta}>
                  добавлен {when(p.createdAt)} · {p.lastUsedAt ? `вход ${when(p.lastUsedAt)}` : 'ещё не использовался'}
                </div>
              </div>
              <button type="button" className={css.icon} onClick={() => remove(p)} disabled={busy} aria-label={`Удалить ключ ${p.name}`}>
                <Trash size={18} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <p className={css.muted}>Ключ из Google Password Manager синхронизируется между устройствами: удаление отключает его везде.</p>
      </div>

      <div className={css.block}>
        <div className={css.blockHead}>
          <h2 className={css.h2}>
            <DeviceMobile size={20} aria-hidden /> Где выполнен вход
          </h2>
          <button type="button" className={css.danger} onClick={everywhere} disabled={busy}>
            Выйти везде
          </button>
        </div>
        <ul className={css.list}>
          {data?.sessions.map((s, i) => (
            <li key={i} className={css.row}>
              <div>
                <div>
                  {s.device} {s.current && <span className={css.badge}>это устройство</span>}
                </div>
                <div className={css.meta}>
                  вход {how(s.method)} {when(s.createdAt)} · активность {when(s.lastUsedAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <button type="button" className={css.ghost} onClick={() => void signOut()}>
          <SignOut size={18} aria-hidden /> Выйти на этом устройстве
        </button>
      </div>

      <div className={css.block}>
        <h2 className={css.h2}>Журнал</h2>
        <ul className={css.list}>
          {data?.events.map((e, i) => (
            <li key={i} className={css.row} data-warn={WARN.has(e.event) || undefined}>
              <div>
                <div>{(EVENTS[e.event] ?? (() => e.event))(e)}</div>
                <div className={css.meta}>
                  {when(e.at)} · {e.device}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

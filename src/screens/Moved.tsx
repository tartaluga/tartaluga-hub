// Прощальная страница старого адреса tartaluga.github.io (ADR-007, съезд со старой версии):
// стирает с устройства старый токен и кэш, снимает service worker и ведёт на новый адрес.
import { useEffect, useState } from 'react'
import { Visor } from '../components/Visor'
import css from './Login.module.css'

const NEW_HOME = 'https://hub.tartaluga.workers.dev/'

async function wipeOldVersion(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('tartaluga-hub') // там лежал токен GitHub
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
  await Promise.all(regs.map((r) => r.unregister()))
  const keys = (await globalThis.caches?.keys?.()) ?? []
  await Promise.all(keys.map((k) => caches.delete(k)))
}

export function Moved() {
  const [done, setDone] = useState(false)
  useEffect(() => {
    void wipeOldVersion().finally(() => setDone(true))
  }, [])

  return (
    <main className={css.page}>
      <div className={css.card}>
        <div className={css.head}>
          <Visor size={64} />
          <div>
            <div className="label">Tartaluga · hub</div>
            <h1 className={css.title}>Хаб переехал</h1>
          </div>
        </div>
        <p className={css.lead}>
          Теперь хаб живёт по новому адресу и входит по ключу доступа или через GitHub, без токена в браузере.
          {done ? ' Старые данные с этого устройства стёрты.' : ' Стираю старые данные с этого устройства…'}
        </p>
        <a className={css.submit} href={NEW_HOME}>
          Открыть hub.tartaluga.workers.dev
        </a>
        <p className={css.lead}>Если хаб был установлен как приложение, удали эту старую иконку и установи хаб заново с нового адреса.</p>
      </div>
    </main>
  )
}

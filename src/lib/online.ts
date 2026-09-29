// Есть ли сеть по мнению браузера (navigator.onLine). «true» не гарантирует связь, «false» — точно нет.
import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const snapshot = () => navigator.onLine !== false

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}

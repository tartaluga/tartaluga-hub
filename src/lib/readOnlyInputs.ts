// Вкладка просмотра (ADR-013): поля ввода не принимают текст, чтобы не набирать впустую — правка всё равно
// не сохранится. Одна точка на весь документ, а не проверка в каждом экране: поле, получившее фокус,
// становится readOnly; когда вкладка стала пишущей, поля возвращаются как были. Поиск остаётся рабочим.

/** Поля, которые только ищут или показывают, — их не трогаем. */
const SKIP_TYPES = new Set(['search', 'checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'file', 'image', 'range', 'color'])

function lockable(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el || typeof el !== 'object') return false
  const tag = (el as { tagName?: unknown }).tagName
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly
  if (tag !== 'INPUT') return false
  const input = el as HTMLInputElement
  return !input.readOnly && !SKIP_TYPES.has(input.type)
}

/** Запретить ввод в поля документа. Возвращает отмену: поля, запертые здесь, снова принимают ввод. */
export function lockInputs(doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'activeElement'>): () => void {
  const locked = new Set<HTMLInputElement | HTMLTextAreaElement>()
  const lock = (el: EventTarget | null) => {
    if (!lockable(el)) return
    el.readOnly = true
    locked.add(el)
  }
  const onFocus = (e: Event) => lock(e.target)
  lock(doc.activeElement)
  doc.addEventListener('focusin', onFocus, true)
  return () => {
    doc.removeEventListener('focusin', onFocus, true)
    for (const el of locked) el.readOnly = false
    locked.clear()
  }
}

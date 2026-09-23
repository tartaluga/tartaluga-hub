import { ScreenStub } from '../components/ScreenStub'
import { useSession } from '../app/session'

export function Today() {
  const files = useSession((s) => s.files)
  const projects = files.filter((f) => f.path.startsWith('projects/')).length
  const ideas = files.filter((f) => f.path.startsWith('ideas/')).length
  const hasSettings = files.some((f) => f.path === 'settings.json')

  return (
    <ScreenStub eyebrow="Скоро · этап 5" title="Сегодня">
      Здесь будут дедлайны на ближайшие 3 дня, следующие шаги по активным проектам, заброшенные проекты и быстрый ввод
      заметки или идеи.
      <br />
      <br />
      <span className="mono">
        Связь с данными: проектов {projects} · идей {ideas} · настройки {hasSettings ? 'загружены' : 'не найдены'}
      </span>
    </ScreenStub>
  )
}

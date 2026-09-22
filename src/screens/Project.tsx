import { useParams } from 'react-router'
import { ScreenStub } from '../components/ScreenStub'

export function Project() {
  const { slug } = useParams()
  return (
    <ScreenStub eyebrow={`Проект · ${slug ?? ''}`} title="Карточка проекта">
      Всё о проекте с правкой на месте: статус, следующий шаг, вехи, задачи, ссылки, лог.
    </ScreenStub>
  )
}

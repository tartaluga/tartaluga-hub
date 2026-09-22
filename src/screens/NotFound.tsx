import { Link } from 'react-router'
import { ScreenStub } from '../components/ScreenStub'

export function NotFound() {
  return (
    <ScreenStub eyebrow="404" title="Такой страницы нет">
      Вернуться на <Link to="/">«Сегодня»</Link>.
    </ScreenStub>
  )
}

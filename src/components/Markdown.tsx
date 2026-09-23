// Markdown из файла данных — недоверенный ввод (ADR-007, STRIDE): сырой HTML выбрасывается, ссылки только
// https:/http:, картинки не грузятся (чужой сервер узнал бы, что карточку открыли) — вместо них подпись.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { webUrl } from '../data/editProject'
import css from './Markdown.module.css'

const safeUrl = (url: string): string | null => (/^https?:\/\//i.test(url) ? webUrl(url) : null)

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span className={css.imgAlt}>[{alt}]</span> : null),
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className={css.md}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => safeUrl(url)} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

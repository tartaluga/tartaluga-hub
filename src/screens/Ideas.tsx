// «Идеи» по макету 2b: быстрый захват, список с фильтром по привязке к проекту, колонка «Стали проектами».
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useSession } from '../app/session'
import { Cover } from '../components/Cover'
import { IdeaCapture } from '../components/IdeaCapture'
import { IdeaRow } from '../components/IdeaRow'
import { buildInbox, FILTER_LABEL, filterIdeas, shortDate, type IdeaFilter } from '../data/ideas'
import { takenSlugs } from '../data/newProject'
import { plural } from '../lib/plural'
import css from './Ideas.module.css'

const FILTERS: IdeaFilter[] = ['all', 'free', 'linked']

const EMPTY_FILTERED: Record<IdeaFilter, string> = {
  all: 'Идей пока нет. Запиши первую — Enter сохраняет.',
  free: 'Все идеи привязаны к проектам.',
  linked: 'Ни одна идея пока не привязана к проекту.',
}

/** «7 ИДЕЙ · 3 БЕЗ ПРОЕКТА». */
export function ideasEyebrow(total: number, free: number): string {
  const head = `${total} ${plural(total, 'идея', 'идеи', 'идей')}`
  return total ? `${head} · ${free} без проекта` : head
}

export function Ideas() {
  const files = useSession((s) => s.files)
  const tree = useSession((s) => s.tree)
  const [filter, setFilter] = useState<IdeaFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const inbox = useMemo(() => buildInbox(files), [files])
  const taken = useMemo(() => takenSlugs(tree?.paths ?? files.map((f) => f.path)), [tree, files])
  const shown = filterIdeas(inbox.ideas, filter)
  const free = inbox.ideas.filter((i) => !i.project).length

  return (
    <section className={css.page}>
      <header>
        <div className="eyebrow">{ideasEyebrow(inbox.ideas.length, free)}</div>
        <h1 className={css.title}>Идеи</h1>
      </header>

      <IdeaCapture />

      <div className={css.columns}>
        <div className={css.main}>
          <div className={css.filters} role="group" aria-label="Какие идеи показать">
            {FILTERS.map((f) => (
              <button key={f} type="button" className={css.filter} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>

          {shown.length ? (
            <ul className={css.list}>
              {shown.map((idea) => (
                <IdeaRow
                  key={idea.id}
                  idea={idea}
                  projects={inbox.projects}
                  taken={taken}
                  open={openId === idea.id}
                  onToggle={(open) => setOpenId(open ? idea.id : null)}
                />
              ))}
            </ul>
          ) : (
            <p className={css.empty}>{inbox.ideas.length ? EMPTY_FILTERED[filter] : EMPTY_FILTERED.all}</p>
          )}

          {inbox.broken.length > 0 && (
            <div className={css.broken}>
              <div className={css.asideTitle}>Не читаются</div>
              <ul>
                {inbox.broken.map((b) => (
                  <li key={b.path}>
                    <span className="mono">{b.path}</span> — {b.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className={css.aside} aria-labelledby="ideas-became">
          <h2 id="ideas-became" className={css.asideTitle}>
            Стали проектами
          </h2>
          {inbox.fromIdeas.length ? (
            <ul className={css.became}>
              {inbox.fromIdeas.map((p) => (
                <li key={p.slug}>
                  <Link className={css.card} to={`/projects/${p.slug}`}>
                    <Cover slug={p.slug} className={css.cover} />
                    <span className={css.cardText}>
                      <span className={css.cardTitle}>{p.title}</span>
                      <span className={css.cardFrom}>из «{p.ideaTitle}»</span>
                    </span>
                    <time className={css.cardDate} dateTime={p.at}>
                      {shortDate(p.at)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={css.empty}>Пока ни одна идея не стала проектом. Открой идею и нажми «Сделать проектом».</p>
          )}
        </aside>
      </div>
    </section>
  )
}

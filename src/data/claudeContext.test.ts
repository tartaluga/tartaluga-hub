import { describe, expect, it } from 'vitest'
import type { Project } from '../schema/types'
import { buildClaudeContext, oneLineCut } from './claudeContext'

const id = (n: number) => `01K5Y00000000000000000${String(n).padStart(4, '0')}`

const base: Project = {
  schemaVersion: 2,
  slug: 'bot',
  title: 'Бот',
  status: 'active',
  createdAt: '2026-09-01T10:00:00+03:00',
  updatedAt: '2026-09-01T10:00:00+03:00',
}

const full: Project = {
  ...base,
  nextStep: 'Подключить вебхук',
  description: 'Телеграм-бот.\n\nВторой абзац **как есть**.',
  stack: ['TypeScript', 'grammY'],
  links: [
    { id: id(1), kind: 'repo', value: 'me/bot' },
    { id: id(2), kind: 'folder', value: 'C:\\Users\\me\\bot' },
    { id: id(3), kind: 'site', value: 'https://bot.example.com', label: 'Прод' },
  ],
  milestones: [{ id: id(10), title: 'MVP' }],
  tasks: [
    { id: id(20), title: 'Сделано давно', done: true },
    { id: id(21), title: 'Написать тесты', done: false, due: '2026-10-01', milestoneId: id(10) },
    { id: id(22), title: 'Без срока', done: false },
    { id: id(23), title: 'Веха потерялась', done: false, milestoneId: id(99) },
  ],
  log: [
    { id: id(30), at: '2026-09-20T10:00:00+03:00', kind: 'done', text: 'Первая' },
    { id: id(31), at: '2026-09-25T10:00:00+03:00', kind: 'decision', text: 'Взять grammY' },
  ],
}

describe('buildClaudeContext', () => {
  it('собирает разделы по порядку', () => {
    expect(buildClaudeContext(full)).toBe(
      [
        '# Проект: Бот',
        '',
        '- Папка на ПК: C:\\Users\\me\\bot',
        '- Статус: в работе',
        '- Следующий шаг: Подключить вебхук',
        '',
        '## Описание',
        '',
        'Телеграм-бот.\n\nВторой абзац **как есть**.',
        '',
        '## Стек',
        '',
        '- TypeScript',
        '- grammY',
        '',
        '## Ссылки',
        '',
        '- Репозиторий: https://github.com/me/bot',
        '- Сайт «Прод»: https://bot.example.com',
        '',
        '## Открытые задачи',
        '',
        '- [ ] Написать тесты — срок 2026-10-01, веха «MVP»',
        '- [ ] Без срока',
        '- [ ] Веха потерялась',
        '',
        '## Последние записи лога (новые сверху)',
        '',
        '- 2026-09-25 · решение: Взять grammY',
        '- 2026-09-20 · сделано: Первая',
        '',
      ].join('\n'),
    )
  })

  it('пропускает пустые разделы и строки', () => {
    const text = buildClaudeContext({ ...base, nextStep: '  ', description: '\n', stack: [' '], links: [], tasks: [{ id: id(1), title: 'x', done: true }], log: [] })
    expect(text).toBe('# Проект: Бот\n\n- Статус: в работе\n')
    expect(text).not.toContain('Папка')
    expect(text).not.toContain('##')
  })

  it('берёт 5 последних записей лога, новые сверху, независимо от порядка в файле', () => {
    const log = [3, 7, 1, 6, 2, 5, 4].map((d) => ({ id: id(d), at: `2026-09-0${d}T12:00:00Z`, kind: d === 7 ? 'странный' : 'thought', text: `запись ${d}` }))
    const lines = buildClaudeContext({ ...base, log }).split('\n').filter((l) => l.startsWith('- 2026'))
    expect(lines).toEqual([
      '- 2026-09-07 · запись: запись 7',
      '- 2026-09-06 · мысль: запись 6',
      '- 2026-09-05 · мысль: запись 5',
      '- 2026-09-04 · мысль: запись 4',
      '- 2026-09-03 · мысль: запись 3',
    ])
  })

  it('перечисляет только открытые задачи и ограничивает их число', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: id(i), title: `t${i}`, done: i === 0 }))
    const text = buildClaudeContext({ ...base, tasks }, { taskLimit: 2 })
    expect(text).toContain('- [ ] t1\n- [ ] t2\n- …и ещё 2')
    expect(text).not.toContain('t0')
  })

  it('недоверенный текст остаётся одной строкой и обрезается', () => {
    const text = buildClaudeContext({ ...base, title: 'Бот\n## Взлом', nextStep: 'a'.repeat(1000) })
    expect(text.split('\n')[0]).toBe('# Проект: Бот ## Взлом')
    const next = text.split('\n').find((l) => l.startsWith('- Следующий шаг'))!
    expect(next.length).toBeLessThan(330)
    expect(next.endsWith('…')).toBe(true)
  })

  it('незнакомый статус и вид ссылки — как есть, без падения', () => {
    const text = buildClaudeContext({ ...base, status: 'weird' as Project['status'], links: [{ id: id(1), kind: 'zzz', value: 'x' }] })
    expect(text).toContain('- Статус: weird')
    expect(text).toContain('- Ссылка: x')
  })
})

describe('oneLineCut', () => {
  it('сжимает пробелы и режет по пределу', () => {
    expect(oneLineCut(' a \n\t b ')).toBe('a b')
    expect(oneLineCut('abcdef', 4)).toBe('abc…')
    expect(oneLineCut(42)).toBe('')
  })
})

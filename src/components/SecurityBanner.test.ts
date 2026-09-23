import { describe, expect, it } from 'vitest'
import { eventsWord } from './SecurityBanner'

describe('склонение «важное событие»', () => {
  it.each([
    [1, 'важное событие'],
    [2, 'важных события'],
    [4, 'важных события'],
    [5, 'важных событий'],
    [11, 'важных событий'],
    [12, 'важных событий'],
    [21, 'важное событие'],
    [22, 'важных события'],
    [111, 'важных событий'],
  ])('%i → %s', (n, word) => expect(eventsWord(n)).toBe(word))
})

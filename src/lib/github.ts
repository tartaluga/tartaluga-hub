// Клиент GitHub REST API для репо данных (ADR-002).
// - Все запросы с cache: 'no-store': GitHub отдаёт max-age=60, и браузер вернул бы старый файл.
// - Все записи идут строго по одной: каждая двигает ветку, параллельные записи конфликтуют.
// - Несколько файлов за раз — одним атомарным коммитом через Git Data API.

import { bytesToBase64, base64ToBytes, decodeText, encodeText } from './base64'

const API = 'https://api.github.com'

export type GitHubErrorKind =
  | 'unauthorized' // 401: токен неверный, истёк или отозван
  | 'forbidden' // 403: у токена нет нужного права
  | 'not_found' // 404: нет файла или токен не видит репо
  | 'conflict' // 409/422 на записи: файл или ветку уже изменили
  | 'already_exists' // создание, а файл уже есть с другим содержимым
  | 'validation' // 422: прочие ошибки запроса
  | 'rate_limited' // исчерпан лимит запросов
  | 'server' // 5xx
  | 'network' // нет сети, CORS, обрыв

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number | null

  constructor(kind: GitHubErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'GitHubError'
    this.kind = kind
    this.status = status
  }
}

export interface TreeEntry {
  path: string
  sha: string
  size: number
}

export interface FileContent {
  text: string
  sha: string
}

/** null — удалить файл. */
export type FileChange = { path: string; content: string | Uint8Array | null }

export interface ClientOptions {
  token: string
  owner: string
  repo: string
  branch?: string
  /** На сервере обязателен: без User-Agent GitHub API отвечает 403. Браузер ставит свой сам. */
  userAgent?: string
  fetch?: typeof fetch
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export class GitHubClient {
  readonly owner: string
  readonly repo: string
  readonly branch: string
  private readonly token: string
  private readonly userAgent: string | undefined
  private readonly fetchImpl: typeof fetch
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(opts: ClientOptions) {
    this.token = opts.token
    this.userAgent = opts.userAgent
    this.owner = opts.owner
    this.repo = opts.repo
    this.branch = opts.branch ?? 'main'
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private get base() {
    return `${API}/repos/${this.owner}/${this.repo}`
  }

  private async request<T>(path: string, init: RequestInit & { accept?: string } = {}): Promise<{ status: number; body: T }> {
    const { accept, ...rest } = init
    let res: Response
    try {
      res = await this.fetchImpl(path.startsWith('http') ? path : this.base + path, {
        ...rest,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
          ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        },
      })
    } catch {
      throw new GitHubError('network', 'Нет связи с GitHub')
    }

    if (res.ok) {
      if (res.status === 204) return { status: res.status, body: undefined as T }
      const isJson = (res.headers.get('content-type') ?? '').includes('json')
      const body = (isJson ? await res.json() : await res.arrayBuffer()) as T
      return { status: res.status, body }
    }

    let message = `HTTP ${res.status}`
    try {
      const err = (await res.json()) as { message?: string }
      if (err.message) message = err.message
    } catch {
      /* тело не JSON — оставляем код */
    }
    throw new GitHubError(kindOf(res, message), message, res.status)
  }

  /** Выполнить запись после всех предыдущих записей этого клиента. */
  private serialWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task)
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /** Проверка токена: видит ли он репо данных. */
  async checkAccess(): Promise<void> {
    // Без слеша в конце: на /repos/o/r/ GitHub не отвечает на CORS-preflight, и браузер блокирует запрос.
    await this.request(``)
  }

  /** Все файлы ветки одним запросом, с sha их содержимого. */
  async listFiles(): Promise<{ commitSha: string; files: TreeEntry[] }> {
    // Сначала коммит, потом его дерево: так список файлов точно соответствует commitSha.
    const head = await this.headCommit()
    const { body } = await this.request<{
      truncated: boolean
      tree: { path: string; type: string; sha: string; size?: number }[]
    }>(`/git/trees/${head}?recursive=1`)
    if (body.truncated) throw new GitHubError('validation', 'В репо данных слишком много файлов для одного запроса')
    return {
      commitSha: head,
      files: body.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })),
    }
  }

  /** Содержимое по sha из listFiles. Работает и для файлов больше 1 МБ. */
  async readBlob(sha: string): Promise<Uint8Array> {
    const { body } = await this.request<{ content: string; encoding: string }>(`/git/blobs/${sha}`)
    if (body.encoding !== 'base64') throw new GitHubError('validation', `Неожиданная кодировка blob: ${body.encoding}`)
    return base64ToBytes(body.content)
  }

  async readBlobText(sha: string): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await this.readBlob(sha))
  }

  /** Файл по пути; null, если его нет. */
  async readFile(path: string, ref = this.branch): Promise<FileContent | null> {
    try {
      const { body } = await this.request<{ sha: string; content?: string; encoding?: string }>(
        `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      )
      if (body.encoding === 'base64' && body.content !== undefined) return { text: decodeText(body.content), sha: body.sha }
      return { text: await this.readBlobText(body.sha), sha: body.sha }
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'not_found') return null
      throw e
    }
  }

  /**
   * Перезаписать существующий файл. sha — версия, с которой начиналась правка.
   * Если файл успели изменить, бросает GitHubError('conflict') — дальше решает слияние (ADR-004).
   */
  updateFile(path: string, text: string, sha: string, message: string): Promise<FileContent> {
    return this.serialWrite(() => this.put(path, text, message, sha))
  }

  /**
   * Создать новый файл. Повторяемо (schema/README.md, правило 6): если файл уже есть
   * с тем же содержимым — это успех (прошлая попытка дошла), с другим — 'already_exists'.
   */
  createFile(path: string, text: string, message: string): Promise<FileContent> {
    return this.serialWrite(async () => {
      try {
        return await this.put(path, text, message)
      } catch (e) {
        if (!(e instanceof GitHubError) || (e.kind !== 'conflict' && e.kind !== 'validation')) throw e
        const existing = await this.readFile(path)
        if (!existing) throw e
        if (existing.text === text) return existing
        throw new GitHubError('already_exists', `Файл ${path} уже существует`, e.status)
      }
    })
  }

  private async put(path: string, text: string, message: string, sha?: string): Promise<FileContent> {
    const { body } = await this.request<{ content: { sha: string } }>(`/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: encodeText(text), branch: this.branch, ...(sha ? { sha } : {}) }),
    })
    return { text, sha: body.content.sha }
  }

  /**
   * Несколько изменений одним коммитом: либо применятся все, либо ни одно.
   * expectedHead — коммит, от которого считались изменения; если ветка ушла вперёд — 'conflict'.
   */
  commitFiles(changes: FileChange[], message: string, expectedHead?: string): Promise<{ commitSha: string; shas: Record<string, string> }> {
    return this.serialWrite(async () => {
      const head = await this.headCommit()
      if (expectedHead && head !== expectedHead) throw new GitHubError('conflict', 'Ветку данных уже изменили')
      const { body: commit } = await this.request<{ tree: { sha: string } }>(`/git/commits/${head}`)

      const shas: Record<string, string> = {}
      const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
      for (const change of changes) {
        if (change.content === null) {
          tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
          continue
        }
        const bytes = typeof change.content === 'string' ? new TextEncoder().encode(change.content) : change.content
        const { body: blob } = await this.request<{ sha: string }>(`/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: bytesToBase64(bytes), encoding: 'base64' }),
        })
        shas[change.path] = blob.sha
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
      }

      const { body: newTree } = await this.request<{ sha: string }>(`/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
      })
      const { body: newCommit } = await this.request<{ sha: string }>(`/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
      })
      // force: false — если ветку сдвинули между шагами, GitHub откажет, и ничего не применится.
      await this.request(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      })
      return { commitSha: newCommit.sha, shas }
    })
  }

  private async headCommit(): Promise<string> {
    return this.branchHead(this.branch)
  }

  // ---------- Ветки (ADR-007). Имена веток проверяет вызывающий код. ----------

  /** Последний коммит ветки. */
  async branchHead(name: string): Promise<string> {
    const { body } = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(name)}`)
    return body.object.sha
  }

  /** Все ветки репо: имя и последний коммит. */
  async listBranches(): Promise<{ name: string; sha: string }[]> {
    const out: { name: string; sha: string }[] = []
    for (let page = 1; page <= 10; page++) {
      const { body } = await this.request<{ name: string; commit: { sha: string } }[]>(`/branches?per_page=100&page=${page}`)
      out.push(...body.map((b) => ({ name: b.name, sha: b.commit.sha })))
      if (body.length < 100) break
    }
    return out
  }

  /** Новая ветка от коммита. Уже есть — 'already_exists'. */
  createBranch(name: string, fromSha: string): Promise<void> {
    return this.serialWrite(async () => {
      await this.request(`/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }) })
    })
  }

  deleteBranch(name: string): Promise<void> {
    return this.serialWrite(async () => {
      await this.request(`/git/refs/heads/${encodeURIComponent(name)}`, { method: 'DELETE' })
    })
  }

  /** Что изменилось в head относительно base: файлы с их новым sha. */
  async compare(
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; files: { path: string; previousPath?: string; status: string; sha: string }[] }> {
    const { body } = await this.request<{
      ahead_by: number
      files?: { filename: string; previous_filename?: string; status: string; sha: string }[]
    }>(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
    return {
      aheadBy: body.ahead_by,
      files: (body.files ?? []).map((f) => ({
        path: f.filename,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        status: f.status,
        sha: f.sha,
      })),
    }
  }

  /**
   * Влить head в base через merge API GitHub. Конфликт — 'conflict', ничего не меняется.
   * null — вливать нечего (head уже в base).
   */
  merge(base: string, head: string, message: string): Promise<string | null> {
    return this.serialWrite(async () => {
      const { status, body } = await this.request<{ sha: string } | undefined>(`/merges`, {
        method: 'POST',
        body: JSON.stringify({ base, head, commit_message: message }),
      })
      return status === 204 || !body ? null : body.sha
    })
  }

  /** Запустить workflow (workflow_dispatch) на ветке, без входных параметров. */
  async dispatchWorkflow(file: string, ref: string): Promise<void> {
    await this.request(`/actions/workflows/${encodeURIComponent(file)}/dispatches`, { method: 'POST', body: JSON.stringify({ ref }) })
  }
}

function kindOf(res: Response, message: string): GitHubErrorKind {
  const s = res.status
  if (s === 401) return 'unauthorized'
  if (s === 429 || (s === 403 && res.headers.get('x-ratelimit-remaining') === '0')) return 'rate_limited'
  if (s === 403) return 'forbidden'
  if (s === 404) return 'not_found'
  if (s === 409) return 'conflict'
  if (s === 422) {
    // GitHub отвечает 422 и на «sha не совпал», и на «ветка ушла вперёд» при обновлении ref.
    if (/sha|fast forward|does not match/i.test(message)) return 'conflict'
    if (/already exists/i.test(message)) return 'already_exists'
    if (/does not exist/i.test(message)) return 'not_found'
    return 'validation'
  }
  if (s >= 500) return 'server'
  return 'validation'
}

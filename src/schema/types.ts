// Сгенерировано scripts/schema.mjs из schema/*.schema.json — не править руками.

export type Link = {
  /**
   * ULID: 26 символов Crockford base32, сортируется по времени создания.
   */
  id: string;
  /**
   * Известные виды: folder — путь к папке на ПК; repo — GitHub-репо в виде owner/name; site — опубликованный сайт; local — локальный URL (localhost); doc — документ; other — прочее. Список открытый: незнакомый вид показывается как обычная ссылка, чтобы новые виды не ломали старые версии приложения.
   */
  kind: string;
  /**
   * folder: путь (C:\\Users\\...); repo: owner/name; остальные: URL.
   */
  value: string;
  label?: string;
};

/**
 * Один проект хаба. Файл projects/<slug>.json. Незнакомые поля разрешены и должны сохраняться всеми, кто пишет файл (ADR-003).
 */
export interface Project {
  /**
   * Версия формата файла. Приложение не перезаписывает файлы с версией выше своей (ADR-003). Версию НЕ повышают при добавлении необязательного поля или значения в открытый список. Повышают только при несовместимом изменении: переименование или удаление поля, смена типа или смысла, новое обязательное поле, новое значение в закрытом списке (status проекта).
   */
  schemaVersion: number;
  /**
   * Латиница в нижнем регистре, цифры и дефисы. Совпадает с именем файла, не меняется после создания.
   */
  slug: string;
  title: string;
  /**
   * Описание проекта. Можно Markdown.
   */
  description?: string;
  /**
   * Технологии и инструменты, по порядку важности.
   */
  stack?: string[];
  /**
   * Id тегов из settings.json. Незнакомый id показывается серым тегом, а не считается ошибкой.
   */
  tags?: string[];
  /**
   * idea — идея, active — в работе, paused — пауза, done — готово, archived — архив. Список закрытый: от статуса зависит логика экранов, поэтому новый статус — это новая schemaVersion.
   */
  status: "idea" | "active" | "paused" | "done" | "archived";
  /**
   * Следующий шаг одной строкой. Пустая строка или отсутствие поля — шаг не задан.
   */
  nextStep?: string;
  /**
   * Путь к обложке в репо данных (covers/<slug>.webp или .jpg). null или отсутствие — генеративная заглушка.
   */
  cover?: string | null;
  links?: Link[];
  /**
   * Вехи по порядку. Прогресс вехи считается по задачам с её milestoneId.
   */
  milestones?: Milestone[];
  tasks?: Task[];
  /**
   * Лента записей. Пишущие добавляют новые записи в конец; читающие не полагаются на порядок в файле и сортируют по at сами.
   */
  log?: LogEntry[];
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  createdAt: string;
  /**
   * Время последней правки. Любой пишущий (приложение, скилл) обновляет его.
   */
  updatedAt: string;
}
export interface Milestone {
  /**
   * ULID: 26 символов Crockford base32, сортируется по времени создания.
   */
  id: string;
  title: string;
  /**
   * Календарная дата без часового пояса: YYYY-MM-DD. Разбирается как местная дата.
   */
  due?: string;
}
export interface Task {
  /**
   * ULID: 26 символов Crockford base32, сортируется по времени создания.
   */
  id: string;
  title: string;
  done: boolean;
  /**
   * Календарная дата без часового пояса: YYYY-MM-DD. Разбирается как местная дата.
   */
  due?: string;
  /**
   * Id вехи, к которой относится задача. Если вехи с таким id нет, задача считается без вехи.
   */
  milestoneId?: string;
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  doneAt?: string;
}
export interface LogEntry {
  /**
   * ULID: 26 символов Crockford base32, сортируется по времени создания.
   */
  id: string;
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  at: string;
  /**
   * Известные виды: done — что сделано; decision — решение; thought — мысль. Список открытый: незнакомый вид показывается как «запись».
   */
  kind: string;
  text: string;
}

/**
 * Одна идея из инбокса. Файл ideas/<id>.json, где id совпадает с именем файла. «Сделать проектом» создаёт проект и удаляет файл идеи одним коммитом.
 */
export interface Idea {
  /**
   * Версия формата файла. Приложение не перезаписывает файлы с версией выше своей (ADR-003). Версию НЕ повышают при добавлении необязательного поля или значения в открытый список. Повышают только при несовместимом изменении: переименование или удаление поля, смена типа или смысла, новое обязательное поле, новое значение в закрытом списке (status проекта).
   */
  schemaVersion: number;
  /**
   * ULID: 26 символов Crockford base32, сортируется по времени создания.
   */
  id: string;
  /**
   * Текст идеи. Первая строка служит заголовком.
   */
  text: string;
  tags?: string[];
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  createdAt: string;
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  updatedAt?: string;
}

/**
 * Общие настройки хаба. Файл settings.json в корне репо данных.
 */
export interface Settings {
  /**
   * Версия формата файла. Приложение не перезаписывает файлы с версией выше своей (ADR-003). Версию НЕ повышают при добавлении необязательного поля или значения в открытый список. Повышают только при несовместимом изменении: переименование или удаление поля, смена типа или смысла, новое обязательное поле, новое значение в закрытом списке (status проекта).
   */
  schemaVersion: number;
  /**
   * Проект «в работе» считается заброшенным, если в логе нет записей дольше этого числа дней. По умолчанию 14.
   */
  abandonedAfterDays?: number;
  /**
   * Теги в порядке показа.
   */
  tags: Tag[];
}
export interface Tag {
  /**
   * Постоянный id. Переименование тега меняет name, id остаётся, поэтому проекты не надо править.
   */
  id: string;
  name: string;
  /**
   * Цвет в формате #rrggbb.
   */
  color: string;
}

/**
 * Живые виджеты. Файл status.json в ветке status. Пишет только GitHub Action (ADR-005); приложение и скилл его только читают.
 */
export interface Status {
  /**
   * Версия формата файла. Приложение не перезаписывает файлы с версией выше своей (ADR-003). Версию НЕ повышают при добавлении необязательного поля или значения в открытый список. Повышают только при несовместимом изменении: переименование или удаление поля, смена типа или смысла, новое обязательное поле, новое значение в закрытом списке (status проекта).
   */
  schemaVersion: number;
  /**
   * Когда Action последний раз отработал (даже с ошибками). null — ещё ни разу.
   */
  generatedAt: string | null;
  /**
   * Когда Action последний раз отработал без ошибок.
   */
  lastSuccess: string | null;
  errors: StatusError[];
  /**
   * Ключ — slug проекта.
   */
  projects: {
    [k: string]: ProjectStatus | undefined;
  };
}
export interface StatusError {
  /**
   * repo_not_accessible — токену статуса не выдан доступ к репо; token_expired — токен истёк; other — прочее.
   */
  code: string;
  message: string;
  project?: string;
  repo?: string;
}
export interface ProjectStatus {
  site?: Site;
  repo?: Repo;
}
export interface Site {
  url: string;
  /**
   * up — отвечает; down — не отвечает или 5xx; blocked — 403/503 от антибот-защиты, проверить не удалось.
   */
  state: "up" | "down" | "blocked";
  httpStatus?: number | null;
  /**
   * Грубая корзина задержки, чтобы не коммитить каждое колебание.
   */
  latency?: "fast" | "ok" | "slow" | null;
  /**
   * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
   */
  checkedAt: string;
  /**
   * Когда state последний раз менялся.
   */
  changedAt?: string;
}
export interface Repo {
  fullName: string;
  /**
   * До 5 последних коммитов ветки по умолчанию, новые первыми.
   *
   * @maxItems 5
   */
  commits?:
    | []
    | [
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        }
      ]
    | [
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        }
      ]
    | [
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        }
      ]
    | [
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        }
      ]
    | [
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        },
        {
          sha: string;
          message: string;
          /**
           * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
           */
          date: string;
          url?: string;
        }
      ];
  lastRun?: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    url?: string;
    /**
     * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
     */
    at?: string;
  };
  deployment?: {
    environment?: string;
    state?: string;
    url?: string | null;
    /**
     * Момент времени в ISO 8601 со смещением: 2026-09-23T14:32:00+03:00 или ...Z.
     */
    at?: string;
  };
  /**
   * Число коммитов по дням (ключ YYYY-MM-DD), накопительно за последние 365 дней. Для тепловой карты.
   */
  commitsByDay?: {
    [k: string]: number | undefined;
  };
}


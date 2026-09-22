# Токен для входа в хаб

Хаб читает и пишет данные в приватный репозиторий `tartaluga/tartaluga-hub-data`. Для этого нужен fine-grained токен GitHub. Один токен подходит для всех устройств: на каждом его вводят один раз.

## Создать токен
1. Открыть https://github.com/settings/personal-access-tokens/new
2. **Token name:** `Tartaluga Hub`
3. **Resource owner:** `tartaluga` (организация, а не личный аккаунт).
4. **Expiration:** Custom → через 1 год. Дату стоит записать: когда токен истечёт, хаб попросит новый.
5. **Repository access:** Only select repositories → `tartaluga/tartaluga-hub-data`. Больше ничего не выбирать.
6. **Permissions → Repository permissions:**
   | Право | Уровень | Зачем |
   |---|---|---|
   | Contents | Read and write | Читать и сохранять проекты, идеи, обложки |
   | Actions | Read and write | Кнопка «Обновить сейчас» у живых виджетов |
   | Metadata | Read-only | Выставляется автоматически |

   **Workflows не включать.** Без этого права токен не может менять файлы workflow, а значит и добраться до секретов репо (ADR-005).
7. Generate token и скопировать значение (`github_pat_…`). GitHub покажет его только один раз.

## Одобрить в организации
Если в организации включено одобрение токенов, токен сначала будет в статусе «pending». Одобрить его: https://github.com/organizations/tartaluga/settings/personal-access-token-requests → Approve.

## Где хранить
- В менеджере паролей. Больше нигде.
- **Не вставлять в чат, заметки, письма, скриншоты.**
- В хабе: экран входа → вставить токен. На iPhone вводить его нужно *внутри установленного приложения*, потому что у установленного PWA своё хранилище, отдельное от Safari.

## Если токен утёк или телефон потерян
https://github.com/settings/personal-access-tokens → токен `Tartaluga Hub` → Revoke. Потом создать новый по этой же инструкции. Данные в репо от этого не пострадают.

# Question Tool — Взаимодействие с пользователем

> Reference для всех скиллов проекта. Используйте форматы ниже для вопросов пользователю.

## Форматы для разных агентов

Разные агенты используют разные форматы для вопросов. Выбирайте подходящий для вашего агента.

---

## Одиночный вопрос

### pi
```
question({
  question: "Текст вопроса?",
  options: [
    { label: "Вариант 1 (Рекомендуется)", description: "Краткое описание" },
    { label: "Вариант 2", description: "Краткое описание" }
  ]
})
```

### Claude Code / Kilo CLI / OpenCode
```
question({
  questions: [{
    header: "Тема",  // max 30 символов
    question: "Текст вопроса?",
    options: [
      { label: "Вариант 1 (Рекомендуется)", description: "Краткое описание" },
      { label: "Вариант 2", description: "Краткое описание" }
    ]
  }]
})
```

---

## Несколько вопросов

### pi
```
questionnaire({
  questions: [
    {
      id: "area",
      label: "Область",      // для tab bar
      prompt: "Какую область затрагивает?",
      options: [
        { value: "frontend", label: "Frontend", description: "UI компоненты" },
        { value: "backend", label: "Backend", description: "API и сервисы" }
      ],
      allowOther: true      // разрешить "Type something..."
    },
    {
      id: "priority",
      label: "Приоритет",
      prompt: "Какой приоритет?",
      options: [
        { value: "high", label: "Высокий", description: "Срочно" },
        { value: "low", label: "Низкий", description: "Не срочно" }
      ]
    }
  ]
})
```

### Claude Code / Kilo CLI / OpenCode
```
question({
  questions: [
    {
      header: "Область",
      question: "Какую область затрагивает?",
      options: [
        { label: "Frontend", description: "UI компоненты" },
        { label: "Backend", description: "API и сервисы" }
      ]
    },
    {
      header: "Приоритет",
      question: "Какой приоритет?",
      options: [
        { label: "Высокий", description: "Срочно" },
        { label: "Низкий", description: "Не срочно" }
      ]
    }
  ]
})
```

---

## Параметры

### question (pi)

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|----------|
| `question` | string | ✅ | Текст вопроса |
| `options` | array | ✅ | Массив вариантов (2-4 элемента) |

### questionnaire (pi)

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|----------|
| `questions` | array | ✅ | Массив вопросов |
| `id` | string | ✅ | Идентификатор вопроса |
| `label` | string | ✅ | Короткий label для tab bar |
| `prompt` | string | ✅ | Полный текст вопроса |
| `options` | array | ✅ | Массив вариантов |
| `allowOther` | boolean | ❌ | Разрешить свой вариант |

### question (другие агенты)

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|----------|
| `questions` | array | ✅ | Массив вопросов (1-4 элемента) |
| `header` | string | ❌ | Короткий заголовок (max 30) |
| `question` | string | ✅ | Текст вопроса |
| `options` | array | ✅ | Массив вариантов |
| `multiple` | boolean | ❌ | Множественный выбор |

### options (общие)

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|----------|
| `label` | string | ✅ | Название варианта |
| `description` | string | ✅ | Краткое описание |
| `value` | string | ❌ | Значение (только questionnaire) |

---

## Правила

1. **2-4 варианта** — не больше
2. **Описание обязательно** — для каждого варианта
3. **Рекомендуемый вариант** — помечать `(Рекомендуется)` или `(Recommended)`
4. **Короткие заголовки** — `header`/`label` max 30 символов
5. **Один вопрос** → `question`, **несколько** → `questionnaire` (pi) / `question` с массивом (другие)

---

## Примеры

### Уточнение области
```
question({
  question: "Какую область затрагивает изменение?",
  options: [
    { label: "Frontend (Рекомендуется)", description: "UI компоненты, стили" },
    { label: "Backend", description: "API, сервисы, база данных" },
    { label: "Оба", description: "Full-stack изменения" }
  ]
})
```

### Подтверждение действия
```
question({
  question: "Применить изменения?",
  options: [
    { label: "Да, применить (Рекомендуется)", description: "Записать изменения в файлы" },
    { label: "Нет, отмена", description: "Вернуться без изменений" }
  ]
})
```

### Выбор следующего шага
```
question({
  question: "Что делать дальше?",
  options: [
    { label: "/aif-verify (Рекомендуется)", description: "Проверить реализацию" },
    { label: "/aif-commit", description: "Закоммитить изменения" },
    { label: "Продолжить", description: "Остаться в текущем контексте" }
  ]
})
```

### Множественный выбор (другие агенты)
```
question({
  questions: [{
    header: "Фичи",
    question: "Какие фичи реализовать?",
    options: [
      { label: "Auth", description: "Аутентификация" },
      { label: "Cache", description: "Кеширование" },
      { label: "Logging", description: "Логирование" }
    ],
    multiple: true
  }]
})
```

---

## Отладка

Если инструмент не работает:

1. Проверьте что extension установлен:
   - pi: `~/.pi/agent/extensions/question.ts`
   - pi: `~/.pi/agent/extensions/questionnaire.ts`

2. Проверьте синтаксис:
   - Все строки в кавычках
   - Запятые между элементами массива
   - Скобки закрыты

3. Проверьте `allowed-tools` в скилле:
   ```
   allowed-tools: ... question questionnaire
   ```

---

## Совместимость

| Агент | question (простой) | questionnaire | question (массив) | multiple |
|-------|-------------------|---------------|-------------------|----------|
| pi | ✅ | ✅ | ❌ | ❌ |
| Claude Code | ❌ | ❌ | ✅ | ✅ |
| Kilo CLI | ❌ | ❌ | ✅ | ✅ |
| OpenCode | ❌ | ❌ | ✅ | ✅ |

[К исследованию](README.md)

# Локальная проверка границ экспорта

Дата: 2026-09-15. Source revision: `02d3f68538abc9ac1712e3396eb69eca74f9e830`.
Среда: Windows, Node `v24.13.0`, установленный AI Factory `2.19.0`.
Машиночитаемый результат: [local-probe.json](local-probe.json).

## Что проверено

1. Создан отдельный временный plugin root с копиями всех файлов `skills/aif-analyze`, `skills/aif-done`, `skills/aif-mode`, `skills/shared`. Копируются также templates; это более полный кандидат, чем первоначальный план «skills + references».
2. Из этого каталога запущен **уже установленный** AI Factory с аргументом `aifhub-mcp`. Получены exit 1 и `error: unknown command 'aifhub-mcp'`.
3. Повторный запуск с `AIFHUB_PROJECT_ROOT`, указывающим на отдельный fixture project, также не регистрирует extension-команду. Источник регистрации в AI Factory 2.19.0 (`dist/cli/index.js`, `loadExtensionCommands`) использует `process.cwd()`, затем project config и список зарегистрированных extensions. Эта проверка не устанавливает расширение.
4. В копии найдены три отсутствующие цели inline Markdown-ссылок:

| Файл | Цель |
|---|---|
| `skills/aif-mode/SKILL.md` | `../../docs/validation-providers.md` |
| `skills/shared/ISOLATED-EXECUTION.md` | `../../docs/isolated-execution.md` |
| `skills/shared/TASK-COORDINATION.md` | `../../docs/workflow-mechanics.md` |

Даже при доступной команде AIFHub выбирает корень проекта из `AIFHUB_PROJECT_ROOT` или текущего каталога: [wrapper](../../commands/aifhub-mcp.mjs), [server](../../scripts/aifhub-mcp-server.mjs), [runtime contract](../aifhub-mcp.md). Поэтому доступность команды и корректность project binding — независимые prerequisites. Наличие CLI не доказывает ни одно из них.

По [Agent Plugins 1.0.0, §7.2.1](https://agent-plugins.org/specification#stdio) omitted `cwd` означает plugin root. Следовательно, исходный перенос MCP-шаблона не сохраняет требуемый запуск из project root. По [§5.2 и §8.1](https://agent-plugins.org/specification#manifest-extension-data) `extensions` неверного типа имеет нефатальную границу обработки; исследование теперь учитывает её отдельно от strict schema validation.

## Как повторить

Выполнять из корня **доверенного checkout** AIFHub. Сохранить следующий блок как `.mjs` вне репозитория. В переменной окружения `AI_FACTORY_ENTRY` указать абсолютный путь к `bin/ai-factory.js` уже установленного AI Factory 2.19.0, затем запустить файл через Node. Скрипт не скачивает CLI. Он создаёт отдельные временные каталоги, копирует только перечисленные skills и выводит JSON в stdout. Для сохранения результата перенаправить stdout в выбранный файл вне проекта. Временные каталоги можно удалить после проверки.

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const cli = process.env.AI_FACTORY_ENTRY;
if (!cli || !path.isAbsolute(cli) || !fs.statSync(cli).isFile()) {
  throw new Error('AI_FACTORY_ENTRY must identify an installed CLI entrypoint');
}
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(cli), '../package.json'), 'utf8'));
if (pkg.name !== 'ai-factory' || pkg.version !== '2.19.0') {
  throw new Error('This probe requires the reviewed ai-factory@2.19.0');
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Run from the AIFHub checkout');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifhub-plugin-probe-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aifhub-project-probe-'));
const inventory = [];
const missingLinks = [];
const portablePath = value => value.split(path.sep).join('/');
for (const name of ['aif-analyze', 'aif-done', 'aif-mode', 'shared']) {
  fs.cpSync(path.join('skills', name), path.join(root, 'skills', name), { recursive: true });
}
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    const content = fs.readFileSync(file);
    const name = portablePath(path.relative(root, file));
    inventory.push({ file: name, sha256: createHash('sha256').update(content).digest('hex') });
    if (!name.endsWith('.md')) continue;
    for (const match of content.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), link))) missingLinks.push({ file: name, link });
    }
  }
}
scan(path.join(root, 'skills'));
function launch(override) {
  const env = { ...process.env };
  delete env.AIFHUB_PROJECT_ROOT;
  if (override) env.AIFHUB_PROJECT_ROOT = project;
  const result = spawnSync(process.execPath, [cli, 'aifhub-mcp'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000
  });
  if (result.error) throw result.error;
  return { exit: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
console.log(JSON.stringify({
  source_revision: revision.stdout.trim(), node: process.version, platform: process.platform,
  ai_factory: pkg.version, no_override: launch(false), project_override: launch(true),
  missing_links: missingLinks, copied_files: inventory
}, null, 2));
```

## Ограничения evidence

- Это диагностическая проба доверенного checkout, **не инспектор внешних недоверенных пакетов**. Копирование и regex не реализуют containment, secret scanning или полноценный Markdown parser. Блок нельзя использовать для импорта произвольного bundle.
- Сканер находит только inline Markdown-ссылки. Он не проверяет anchors, reference-style links, пути в prose/коде, frontmatter или семантику инструкций. Три найденные ссылки — доказательство неполноты исходного кандидата, не полный dependency inventory будущего экспорта.
- После включения этих документов нужно вычислить следующие зависимости и ограничить их явным inventory; добавление только трёх файлов не заявлено как достаточное исправление пакета.
- JSON фиксирует source commit и digests реально скопированных файлов, что позволяет заметить локальные изменения относительно commit. Он не является подписанным acceptance receipt.
- Проба не создаёт `plugin.json`, не выполняет Agent Skills validation, не загружает пакет в клиент и не проводит MCP handshake. `format_valid`, `loads`, `workflow_semantics_verified` остаются NOT_RUN. Положительный сценарий с зарегистрированным AIFHub и правильным проектом ещё не проверен в Agent Plugins host.
- Полный baseline test suite (1507/1507) проверяет существующее расширение; результаты этой пробы и будущий plugin smoke должны учитываться отдельно.

# Pre-staged sqz artifacts

Для текущей 12-row runtime matrix поместите в `bin/` user-owned Windows binary:

- `sqz.exe` v1.3.0, SHA-256 `0C21ADFA0C67B6EB61EDD2B8B87C836AC2757A58D0D68D93376606E6CC75E76B`;

Generator запускает официальный CLI через реальный
`aifhub.contextDedup.mode: sqz`, копирует binary в fresh AI Tester sandbox и
повторно проверяет hash до model turn. Binary не входит в репозиторий.

Отдельный исторический authored scenario `variant-b-sqz.yaml` использует два
user-owned Windows binary:

- тот же `sqz.exe`;
- `sqz-isolated-adapter.exe`, SHA-256 `36318B6299026A3CFCF8D0E2D76EFF9FE7060889C72E0FA9B735F7C2918E0607`.

Adapter нужен только этому authored/legacy benchmark path, а не текущей
runtime matrix. Сценарий копирует каталог в fresh sandbox и повторно проверяет
hashes до model turn.

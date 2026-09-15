# Pi SQZ context-dedup live matrix (3 runs, anonymized labels)

Agent: pi (print mode) · model `la/ornith-1.5-35b-a3b` @ omniroute · thinking low.
Bytes = model-visible payload measured by the dedup `read` override; tokens = measured provider usage from session files. Cost: provider reports no per-token price for this model, so cost is not computable (`unavailable`).

## Per-cell results

| project | task | arm | quality | turns | in tok | out tok | reads | obs B | served B | saved B | saved % | warnings |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| unity-csharp|exec:chamber-field|aifhub|PASS|5|9,478|425|1|29,099|29,099|0|0.0%|0 |
| unity-csharp|exec:chamber-field|aifhub|PASS|4|7,591|420|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|exec:chamber-field|aifhub|PASS|5|9,591|405|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|exec:chamber-field|off|FAIL|5|10,309|495|2|58,150|58,150|0|0.0%|0 |
| unity-csharp|exec:chamber-field|off|PASS|4|7,573|308|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|exec:chamber-field|off|PASS|4|7,743|334|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|exec:chamber-field|sqz|FAIL|6|13,352|612|1|29,051|15,518|13,533|46.6%|0 |
| unity-csharp|exec:chamber-field|sqz|PASS|4|7,076|280|0|0|0|0|n/a|0 |
| unity-csharp|exec:chamber-field|sqz|PASS|7|15,282|731|1|29,051|15,518|13,533|46.6%|0 |
| unity-csharp|research:domain-model|aifhub|PASS|4|41,545|1,229|2|90,309|90,309|0|0.0%|0 |
| unity-csharp|research:domain-model|aifhub|PASS|5|60,732|1,890|2|90,309|90,309|0|0.0%|0 |
| unity-csharp|research:domain-model|aifhub|PASS|3|22,473|1,015|2|90,309|90,309|0|0.0%|0 |
| unity-csharp|research:domain-model|off|PASS|4|20,879|1,120|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|research:domain-model|off|PASS|3|18,118|1,093|1|29,051|29,051|0|0.0%|0 |
| unity-csharp|research:domain-model|off|PASS|4|41,532|1,259|2|90,309|90,309|0|0.0%|0 |
| unity-csharp|research:domain-model|sqz|PASS|5|27,466|1,658|1|29,051|15,518|13,533|46.6%|0 |
| unity-csharp|research:domain-model|sqz|FAIL|7|78,175|1,089|n/a|n/a|n/a|n/a|n/a|n/a |
| unity-csharp|research:domain-model|sqz|PASS|7|79,564|2,327|4|180,618|51,171|129,447|71.7%|0 |
| flutter-dart|exec:settings-version-note|aifhub|PASS|4|7,290|278|1|5,260|5,260|0|0.0%|0 |
| flutter-dart|exec:settings-version-note|aifhub|PASS|3|5,129|369|1|5,286|5,286|0|0.0%|0 |
| flutter-dart|exec:settings-version-note|aifhub|PASS|3|5,131|236|0|0|0|0|n/a|0 |
| flutter-dart|exec:settings-version-note|off|PASS|4|6,909|256|0|0|0|0|n/a|0 |
| flutter-dart|exec:settings-version-note|off|PASS|9|19,860|1,223|1|5,312|5,312|0|0.0%|0 |
| flutter-dart|exec:settings-version-note|off|PASS|3|5,127|190|0|0|0|0|n/a|0 |
| flutter-dart|exec:settings-version-note|sqz|PASS|5|9,415|324|1|5,286|1,312|3,974|75.2%|0 |
| flutter-dart|exec:settings-version-note|sqz|PASS|5|9,225|321|1|5,286|1,312|3,974|75.2%|0 |
| flutter-dart|exec:settings-version-note|sqz|PASS|5|9,286|322|1|5,260|1,434|3,826|72.7%|0 |
| flutter-dart|research:features-layer|aifhub|PASS|4|22,088|743|3|29,006|29,006|0|0.0%|0 |
| flutter-dart|research:features-layer|aifhub|FAIL|6|31,634|584|3|29,032|29,032|0|0.0%|0 |
| flutter-dart|research:features-layer|aifhub|FAIL|4|21,966|640|3|29,006|29,006|0|0.0%|0 |
| flutter-dart|research:features-layer|off|FAIL|3|11,239|498|2|25,413|25,413|0|0.0%|0 |
| flutter-dart|research:features-layer|off|FAIL|1|1,655|82|n/a|n/a|n/a|n/a|n/a|n/a |
| flutter-dart|research:features-layer|off|FAIL|4|18,433|544|2|23,746|23,746|0|0.0%|0 |
| flutter-dart|research:features-layer|sqz|PASS|5|21,818|969|4|49,159|22,778|26,381|53.7%|0 |
| flutter-dart|research:features-layer|sqz|FAIL|7|32,607|1,031|4|44,292|12,059|32,233|72.8%|0 |
| flutter-dart|research:features-layer|sqz|FAIL|8|42,380|1,088|6|53,145|13,723|39,422|74.2%|0 |
| react-typescript|exec:subtitle-swap|aifhub|PASS|10|20,934|1,289|2|9,882|9,882|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|aifhub|PASS|5|8,896|330|1|4,946|4,946|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|aifhub|PASS|5|9,011|422|1|4,946|4,946|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|off|PASS|5|8,879|347|1|4,946|4,946|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|off|PASS|5|8,761|426|1|4,946|4,946|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|off|PASS|6|13,978|462|1|4,946|4,946|0|0.0%|0 |
| react-typescript|exec:subtitle-swap|sqz|PASS|8|24,025|873|1|4,936|3,349|1,587|32.2%|0 |
| react-typescript|exec:subtitle-swap|sqz|PASS|7|13,860|531|2|9,892|3,580|6,312|63.8%|0 |
| react-typescript|exec:subtitle-swap|sqz|PASS|6|11,330|471|1|4,946|3,349|1,597|32.3%|0 |
| react-typescript|research:landing|aifhub|PASS|6|28,008|1,016|5|18,198|18,198|0|0.0%|0 |
| react-typescript|research:landing|aifhub|PASS|4|16,005|762|4|15,062|15,062|0|0.0%|0 |
| react-typescript|research:landing|aifhub|PASS|6|29,788|965|4|15,275|15,275|0|0.0%|0 |
| react-typescript|research:landing|off|PASS|4|15,920|897|4|14,966|14,966|0|0.0%|0 |
| react-typescript|research:landing|off|PASS|4|13,788|749|4|15,062|15,062|0|0.0%|0 |
| react-typescript|research:landing|off|PASS|3|10,731|627|4|15,275|15,275|0|0.0%|0 |
| react-typescript|research:landing|sqz|PASS|5|23,235|1,082|4|14,966|7,851|7,115|47.5%|0 |
| react-typescript|research:landing|sqz|PASS|5|19,175|932|3|14,874|7,644|7,230|48.6%|0 |
| react-typescript|research:landing|sqz|PASS|7|38,474|1,243|4|15,275|7,839|7,436|48.7%|0 |
| laravel-php|exec:issuer-constant|aifhub|PASS|4|9,161|392|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|aifhub|PASS|3|6,520|333|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|aifhub|PASS|3|6,504|402|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|off|PASS|4|9,249|493|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|off|PASS|3|6,504|331|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|off|PASS|4|9,161|369|1|3,112|3,112|0|0.0%|0 |
| laravel-php|exec:issuer-constant|sqz|PASS|6|14,017|626|3|9,424|4,670|4,754|50.4%|0 |
| laravel-php|exec:issuer-constant|sqz|PASS|8|19,819|844|4|12,448|2,909|9,539|76.6%|0 |
| laravel-php|exec:issuer-constant|sqz|ERROR|n/a|n/a|n/a|n/a|n/a|n/a|n/a|n/a|n/a |
| laravel-php|research:issuer-domain|aifhub|PASS|4|12,770|1,606|4|6,754|6,754|0|0.0%|0 |
| laravel-php|research:issuer-domain|aifhub|PASS|5|15,973|961|3|5,446|5,446|0|0.0%|0 |
| laravel-php|research:issuer-domain|aifhub|PASS|3|7,413|787|3|5,446|5,446|0|0.0%|0 |
| laravel-php|research:issuer-domain|off|PASS|4|12,297|1,078|3|5,446|5,446|0|0.0%|0 |
| laravel-php|research:issuer-domain|off|PASS|6|20,814|903|3|5,446|5,446|0|0.0%|0 |
| laravel-php|research:issuer-domain|off|PASS|3|8,047|776|3|5,446|5,446|0|0.0%|0 |
| laravel-php|research:issuer-domain|sqz|PASS|3|8,552|777|3|5,446|4,478|968|17.8%|0 |
| laravel-php|research:issuer-domain|sqz|PASS|3|7,194|841|3|5,446|4,478|968|17.8%|0 |
| laravel-php|research:issuer-domain|sqz|PASS|3|9,917|1,038|5|13,401|9,314|4,087|30.5%|0 |
| python-ts-monorepo|exec:prompt-error-msg|aifhub|PASS|7|17,225|643|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|exec:prompt-error-msg|aifhub|PASS|4|7,216|370|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|exec:prompt-error-msg|aifhub|PASS|5|9,299|466|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|exec:prompt-error-msg|off|PASS|3|6,491|281|0|0|0|0|n/a|0 |
| python-ts-monorepo|exec:prompt-error-msg|off|PASS|4|9,410|386|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|exec:prompt-error-msg|off|PASS|4|9,234|355|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|exec:prompt-error-msg|sqz|PASS|7|19,484|706|3|213,682|98,659|115,023|53.8%|0 |
| python-ts-monorepo|exec:prompt-error-msg|sqz|PASS|6|15,442|489|1|71,228|32,877|38,351|53.8%|0 |
| python-ts-monorepo|exec:prompt-error-msg|sqz|PASS|4|8,372|448|0|0|0|0|n/a|0 |
| python-ts-monorepo|research:architecture|aifhub|PASS|5|17,100|1,224|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|research:architecture|aifhub|FAIL|8|43,028|2,187|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|research:architecture|aifhub|PASS|7|78,634|2,104|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|research:architecture|off|PASS|3|19,502|1,510|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|research:architecture|off|PASS|9|82,546|2,039|2|142,456|142,456|0|0.0%|0 |
| python-ts-monorepo|research:architecture|off|PASS|5|40,858|1,983|1|71,228|71,228|0|0.0%|0 |
| python-ts-monorepo|research:architecture|sqz|PASS|10|90,047|2,108|2|142,456|33,149|109,307|76.7%|0 |
| python-ts-monorepo|research:architecture|sqz|PASS|6|52,520|1,757|2|142,456|33,127|109,329|76.7%|0 |
| python-ts-monorepo|research:architecture|sqz|PASS|7|69,088|1,786|1|71,228|32,795|38,433|54.0%|0 |
| fastapi-react|exec:participant-length|aifhub|PASS|3|5,926|265|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|aifhub|PASS|3|5,926|259|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|aifhub|PASS|3|5,926|229|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|off|PASS|3|5,926|222|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|off|PASS|3|5,926|211|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|off|PASS|3|5,926|208|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|sqz|PASS|3|5,924|286|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|sqz|PASS|3|5,926|237|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|exec:participant-length|sqz|PASS|3|5,926|254|1|1,977|1,977|0|0.0%|0 |
| fastapi-react|research:backend-models|aifhub|PASS|4|10,435|1,050|5|5,859|5,859|0|0.0%|0 |
| fastapi-react|research:backend-models|aifhub|PASS|3|9,228|1,164|11|14,142|14,142|0|0.0%|0 |
| fastapi-react|research:backend-models|aifhub|PASS|4|14,905|1,181|12|14,865|14,865|0|0.0%|0 |
| fastapi-react|research:backend-models|off|PASS|4|14,635|1,163|12|14,865|14,865|0|0.0%|0 |
| fastapi-react|research:backend-models|off|PASS|3|9,356|1,226|12|14,865|14,865|0|0.0%|0 |
| fastapi-react|research:backend-models|off|FAIL|4|14,959|1,113|12|14,865|14,865|0|0.0%|0 |
| fastapi-react|research:backend-models|sqz|PASS|3|10,375|1,299|12|14,865|14,603|262|1.8%|0 |
| fastapi-react|research:backend-models|sqz|PASS|3|9,917|1,317|12|14,865|14,605|260|1.7%|0 |
| fastapi-react|research:backend-models|sqz|PASS|4|16,406|1,297|12|14,865|14,605|260|1.7%|0 |

## Aggregates by project × arm (mean over cells)

| project | arm | cells | quality pass | mean in tok | mean out tok | mean saved % |
|---|---|---:|---:|---:|---:|---:|
| fastapi-react | aifhub | 6 | 6/6 | 9,415.667 | 0.0% |
| fastapi-react | off | 6 | 5/6 | 10,145.167 | 0.0% |
| fastapi-react | sqz | 6 | 6/6 | 9,860.667 | 0.9% |
| flutter-dart | aifhub | 6 | 4/6 | 16,014.667 | 0.0% |
| flutter-dart | off | 6 | 3/6 | 11,002.667 | 0.0% |
| flutter-dart | sqz | 6 | 4/6 | 21,464.333 | 70.6% |
| laravel-php | aifhub | 6 | 6/6 | 10,470.333 | 0.0% |
| laravel-php | off | 6 | 6/6 | 11,670.333 | 0.0% |
| laravel-php | sqz | 6 | 5/6 | 10,604.167 | 32.2% |
| python-ts-monorepo | aifhub | 6 | 5/6 | 29,916 | 0.0% |
| python-ts-monorepo | off | 6 | 6/6 | 29,099.167 | 0.0% |
| python-ts-monorepo | sqz | 6 | 6/6 | 43,707.833 | 52.5% |
| react-typescript | aifhub | 6 | 6/6 | 19,571 | 0.0% |
| react-typescript | off | 6 | 6/6 | 12,594.167 | 0.0% |
| react-typescript | sqz | 6 | 6/6 | 22,538.5 | 45.5% |
| unity-csharp | aifhub | 6 | 6/6 | 26,132.333 | 0.0% |
| unity-csharp | off | 6 | 5/6 | 18,460.5 | 0.0% |
| unity-csharp | sqz | 6 | 4/6 | 37,935.333 | 35.2% |

## Verdict inputs

- FAILED cells: `unity-csharp·exec-chamber-field·off`, `unity-csharp·exec-chamber-field·sqz`, `unity-csharp·research-domain-model·sqz`, `flutter-dart·research-features-layer·aifhub`, `flutter-dart·research-features-layer·aifhub`, `flutter-dart·research-features-layer·off`, `flutter-dart·research-features-layer·off`, `flutter-dart·research-features-layer·off`, `flutter-dart·research-features-layer·sqz`, `flutter-dart·research-features-layer·sqz`, `python-ts-monorepo·research-architecture·aifhub`, `fastapi-react·research-backend-models·off`
- ERRORED cells: `laravel-php·exec-issuer-constant·sqz`
- Cells with dedup warnings: none
- Repetitions: see `--repeats`; single-run cells are noisy trajectories, compare arms only via aggregates.

import { sharedBanner } from '../../../../packages/shared/src/index.js';
import { analyticsBanner } from '../../../../packages/analytics/src/index.js';

export function runIncrementalApp() {
  return `${sharedBanner()} ${analyticsBanner()}`;
}

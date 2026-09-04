// chunk: c021
export function shouldRefreshCache(ageMs: number) {
  return ageMs > 300_000;
}

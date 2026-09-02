// chunk: c027
export async function restoreBackup(snapshotId: string) {
  return { snapshotId, target: 'isolated-validation-database' };
}

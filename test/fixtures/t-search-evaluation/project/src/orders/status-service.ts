// chunk: c012
import { publishOrderAudit } from '../audit/publisher.js';

export async function changeOrderStatus(orderId: string, nextStatus: string) {
  const updated = { orderId, status: nextStatus };
  await publishOrderAudit(updated.orderId, updated.status);
  return updated;
}

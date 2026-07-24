import { updateOrderStatus } from '../domain/orders/service.js';
import { publishAudit } from '../integrations/audit/publish.js';

export async function handleStatusUpdate(order) {
  const status = updateOrderStatus(order);
  await publishAudit(status);
  return status;
}

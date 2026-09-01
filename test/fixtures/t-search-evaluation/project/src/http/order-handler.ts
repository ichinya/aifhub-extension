// chunk: c014
import { changeOrderStatus } from '../orders/status-service.js';

export async function handleOrderStatus(request: { orderId: string; nextStatus: string }) {
  return changeOrderStatus(request.orderId, request.nextStatus);
}

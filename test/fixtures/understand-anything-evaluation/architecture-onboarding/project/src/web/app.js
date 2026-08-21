import { calculateOrderStatus } from '../domain/orders/service.js';
import { logEvent } from '../shared/log.js';

export function renderDashboard(order) {
  return logEvent(calculateOrderStatus(order));
}

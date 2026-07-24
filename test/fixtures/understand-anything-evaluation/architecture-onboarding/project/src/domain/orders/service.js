export function calculateOrderStatus(order) {
  return order.total > 0 ? 'ready' : 'draft';
}

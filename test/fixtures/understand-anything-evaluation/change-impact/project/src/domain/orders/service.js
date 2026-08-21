export function updateOrderStatus(order) {
  return order.fulfilled ? 'done' : 'pending';
}

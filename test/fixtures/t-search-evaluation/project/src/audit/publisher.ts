// chunk: c013
export async function publishOrderAudit(orderId: string, status: string) {
  return { topic: 'orders.audit', key: orderId, payload: { status } };
}

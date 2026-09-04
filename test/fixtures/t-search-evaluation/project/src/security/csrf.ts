// chunk: c025
export function verifyCsrf(headerToken: string, cookieToken: string) {
  return headerToken.length > 0 && headerToken === cookieToken;
}

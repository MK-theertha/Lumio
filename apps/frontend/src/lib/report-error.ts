import axios from 'axios';

const MAX_PER_PAGE = 10;
let sent = 0;

/** Sends a browser crash to the API. Reporting must never itself cause an error. */
export function reportClientError(error: unknown, componentStack?: string): void {
  if (sent >= MAX_PER_PAGE) return;
  sent += 1;
  const failure = error instanceof Error ? error : new Error(String(error));
  axios
    .post(
      '/api/v1/client-errors',
      {
        message: failure.message.slice(0, 2000),
        ...(failure.stack ? { stack: failure.stack.slice(0, 10_000) } : {}),
        ...(componentStack ? { componentStack: componentStack.slice(0, 10_000) } : {}),
        // The path only: query strings can carry tokens, such as on the reset password link.
        path: window.location.pathname.slice(0, 500),
      },
      { headers: { 'X-Requested-With': 'lumio' } },
    )
    .catch(() => undefined);
}

export function installErrorReporting(): void {
  window.addEventListener('error', (event) => reportClientError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportClientError(event.reason));
}

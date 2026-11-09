import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportClientError } from '@/lib/report-error';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, info.componentStack ?? undefined);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-8 text-sm">
        Something went wrong. Please reload the page.
      </div>
    );
  }
}

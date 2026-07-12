import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  fallback: ReactNode;
  children: ReactNode;
  /**
   * When any value here changes, the boundary clears its error and re-renders the
   * children. Without it a caught error is permanent: once a bad GLB trips the
   * viewer, switching to a good model would keep showing the fallback forever.
   */
  resetKeys?: ReadonlyArray<unknown>;
}
interface State {
  hasError: boolean;
}

function keysChanged(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

/**
 * Contains a render/runtime failure (a bad GLB, WebGL unavailable) to one pane so
 * the rest of the app keeps working instead of white-screening.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught', error, info);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.hasError && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false });
    }
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

import { Component, type ReactNode } from 'react';

/**
 * Keeps one broken part of the page (a message that cannot be drawn, say) from taking the rest
 * down with it: the part shows `fallback` instead, and the error goes to the console.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('render failed', error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

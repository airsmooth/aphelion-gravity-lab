import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import GravityLab from "@/app/components/GravityLab";
import "@/app/globals.css";
import "./desktop.css";

interface BoundaryState {
  failed: boolean;
}

class DesktopErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Aphelion renderer error", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="desktop-error">
          <p>APHELION / RECOVERY MODE</p>
          <h1>The simulation stopped unexpectedly.</h1>
          <span>Your system is safe. Reload the local instrument to start again.</span>
          <button onClick={() => window.location.reload()}>RELOAD INSTRUMENT</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Desktop root element was not created.");

createRoot(root).render(
  <DesktopErrorBoundary>
    <GravityLab />
  </DesktopErrorBoundary>,
);

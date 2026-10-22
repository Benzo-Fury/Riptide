import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";
import { startStore } from "./lib/store";
import { App } from "./App";
import { TooltipHost } from "./components/Tooltip";

/** The longest the first frame waits for state; anything later lands as it arrives. */
const FIRST_FRAME_WAIT_MS = 1500;

// Fonts first, so the first frame is set in the right faces; then state (briefly), then the UI
const state = Promise.race([startStore(), new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_WAIT_MS))]);
Promise.allSettled([document.fonts.ready, state]).finally(() => {
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<App />
			<TooltipHost />
		</StrictMode>,
	);
});

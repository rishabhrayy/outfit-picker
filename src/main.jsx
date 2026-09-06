import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import services from "./services";
import "./index.css";

// registerType is "autoUpdate", so the generated service worker calls
// skipWaiting and the page reloads itself once the new version takes over.
// An onNeedRefresh prompt would never fire in this mode.
registerSW({ immediate: true });

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>
);

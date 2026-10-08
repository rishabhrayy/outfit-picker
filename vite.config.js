import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { handleGeminiProxy } from "./server/geminiProxy.js";

// Serves the built-in AI route during `npm run dev`, the way Vercel serves
// api/gemini/chat/completions.js in production. Reads GEMINI_API_KEY and
// APP_PASSCODE from .env.local (git-ignored).
function builtInAiDevRoute(env) {
  return {
    name: "built-in-ai-dev-route",
    configureServer(server) {
      server.middlewares.use("/api/gemini/chat/completions", (req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", async () => {
          // BUILTIN_AI_UPSTREAM (e.g. the deployed site) forwards to that site's
          // route instead, so local testing can use the key held on the host
          // without copying it onto the development machine.
          if (env.BUILTIN_AI_UPSTREAM) {
            try {
              const upstream = await fetch(`${env.BUILTIN_AI_UPSTREAM.replace(/\/+$/, "")}/api/gemini/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" },
                body: raw,
              });
              res.statusCode = upstream.status;
              res.setHeader("Content-Type", "application/json");
              res.end(await upstream.text());
            } catch {
              res.statusCode = 502;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: { message: "Could not reach BUILTIN_AI_UPSTREAM." } }));
            }
            return;
          }
          let body = null;
          try { body = raw ? JSON.parse(raw) : null; } catch { /* rejected below as not JSON */ }
          const result = await handleGeminiProxy({ method: req.method, authorization: req.headers.authorization, body, env });
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result.body));
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    builtInAiDevRoute(loadEnv(mode, process.cwd(), "")),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Outfit Picker",
        short_name: "Outfits",
        description: "A private, local-first wardrobe and outfit picker.",
        theme_color: "#5d4fc3",
        background_color: "#fcfbff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Padded so Android's circular and squircle masks do not clip the shirt.
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp}"]
      }
    })
  ]
}));

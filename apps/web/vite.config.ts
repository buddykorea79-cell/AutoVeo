import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

const serverTarget = process.env.VITE_SERVER_TARGET ?? "http://127.0.0.1:5178";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": serverTarget,
      "/assets": serverTarget,
    },
  },
});

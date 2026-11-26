import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La API corre aparte (npm run dev en la raiz). El navegador le habla directo
// a VITE_API_BASE; el backend tiene a http://localhost:5173 en CORS_ORIGENES.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});

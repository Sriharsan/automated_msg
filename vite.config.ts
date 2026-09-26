import { defineConfig } from 'vite'
export default defineConfig({server:{proxy:{'/api':'http://127.0.0.1:8787','/webhooks':'http://127.0.0.1:8787'}}})

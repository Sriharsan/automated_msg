import { defineConfig } from 'vite'
export default defineConfig({server:{proxy:{'/api':'http://localhost:8787','/webhooks':'http://localhost:8787'}}})

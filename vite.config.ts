import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { phoneUpload } from './server/phone-upload';

export default defineConfig({
  plugins: [react(), phoneUpload()],
  // 휴대폰(QR 업로드)이 같은 와이파이에서 접속할 수 있도록 네트워크에 연다
  server: { host: true },
  preview: { host: true },
});

# Technology stack

- Electron 44 / sandboxed Chromium WebContentsView profiles
- React 19 / TypeScript 5.9 / Vite 8
- esbuild main, CommonJS preload and CLI bundles
- Node.js 24 built-in SQLite, filesystem and HTTP
- electron-builder: macOS DMG, Windows NSIS, Linux AppImage
- Node test runner + tsx for core/API/CLI tests
- Playwright Electron driver for offline desktop tests

Versions are pinned in package.json/package-lock.json. Use npm ci. TypeScript uses the JavaScript 5.9 compiler to avoid requiring a separate native compiler executable.

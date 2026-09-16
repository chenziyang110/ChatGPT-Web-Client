# ChatGPT-Web-Client Architecture

## High Level

```
User
 |
Electron Application
 |
+----------------------+
| UI                   |
| Account Manager      |
| Session Manager      |
| Agent Gateway        |
| Storage Layer        |
+----------------------+
 |
Agent Runtime
 |
AnythingCLI / Tools
```

## Technology

- Electron
- React
- TypeScript
- SQLite
- Chromium Profile Isolation
- Playwright (future)

## Data

Local storage contains:

- account metadata
- session state
- task information

## Security

- Local-first storage
- Account separation
- No remote credential upload

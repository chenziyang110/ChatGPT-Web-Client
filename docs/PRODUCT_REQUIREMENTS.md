# ChatGPT-Web-Client Product Requirements

## 1. Overview

ChatGPT-Web-Client is a desktop AI workspace runtime built with Electron.

The goal is not only a web wrapper, but a local environment for managing AI accounts and Agent workflows.

## 2. Core Features

### Electron Desktop Client

- Cross-platform desktop application
- Fast startup and restore

### ChatGPT Web Runtime

- Embedded ChatGPT web experience
- Independent browser environment

### Multi Account Isolation

Each account has isolated:

- Cookies
- LocalStorage
- Session data
- Browser profile

### Session Persistence

Restore:

- Last account
- Last page
- Window state
- Working context

### Agent Runtime

Provide local runtime for external agents.

### AnythingCLI Integration

Expose CLI and local API interfaces for agent calls.

## 3. Future Extensions

- Browser Agent
- MCP support
- Plugin system
- Multiple AI providers

## 4. Development Phases

1. Electron foundation
2. Account isolation
3. Session manager
4. Agent gateway
5. CLI integration
6. Browser automation

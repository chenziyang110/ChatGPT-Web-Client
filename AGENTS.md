# AGENTS.md

## Project Goal

Build ChatGPT-Web-Client as a local AI workspace runtime.

## Core Principles

1. Account isolation first

Each AI account must have independent:

- cookies
- local storage
- sessions

2. Local-first

Never upload user credentials or browser profiles.

3. Modular architecture

Separate:

- UI
- Electron runtime
- Agent runtime
- Storage

4. Agent friendly

Major capabilities should expose:

- IPC
- API
- CLI

## Architecture

```
Electron
 |
 +-- Renderer
 +-- Main Process
 +-- Account Manager
 +-- Session Manager
 +-- Agent Runtime
 +-- Storage
```

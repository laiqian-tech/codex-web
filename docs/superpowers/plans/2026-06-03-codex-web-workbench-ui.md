# Codex Web Workbench UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the minimal Codex Web demo into a practical Mac-app-inspired workbench with better navigation, status visibility, and mobile usability.

**Architecture:** Keep the current static frontend and local Node proxy. Improve the app shell, client-side state, rendering functions, and responsive behavior without introducing a framework or changing the Codex app-server integration.

**Tech Stack:** Vanilla HTML, CSS, JavaScript, Node.js local proxy, Playwright/Chrome for verification.

---

### Task 1: Navigation And Thread Controls

**Files:**
- Modify: `/Users/macbook/Documents/codex-app/index.html`
- Modify: `/Users/macbook/Documents/codex-app/script.js`
- Modify: `/Users/macbook/Documents/codex-app/styles.css`

- [x] Add project and thread search inputs in the left rail.
- [x] Add refresh current data and reload current thread controls.
- [x] Render project thread counts and thread metadata.
- [x] Keep selected project/thread stable after sync.
- [x] Verify project filtering and thread filtering in Chrome.

### Task 2: Conversation Experience

**Files:**
- Modify: `/Users/macbook/Documents/codex-app/index.html`
- Modify: `/Users/macbook/Documents/codex-app/script.js`
- Modify: `/Users/macbook/Documents/codex-app/styles.css`

- [x] Add topbar metadata for current cwd, thread id, and message count.
- [x] Add compact message styling with role badges and readable long-message wrapping.
- [x] Add `Ctrl/Cmd+Enter` send and `Enter` newline behavior.
- [x] Add prompt hint chips that fill the composer.
- [x] Preserve send error handling and processing state.

### Task 3: Inspector And Runtime Feedback

**Files:**
- Modify: `/Users/macbook/Documents/codex-app/index.html`
- Modify: `/Users/macbook/Documents/codex-app/script.js`
- Modify: `/Users/macbook/Documents/codex-app/styles.css`

- [x] Replace the raw connection panel with a runtime summary.
- [x] Show backend status, source, current thread status, project path, and recent events.
- [x] Add manual event refresh.
- [x] Keep the existing `/api/events` polling during turns.

### Task 4: Responsive Polish And Verification

**Files:**
- Modify: `/Users/macbook/Documents/codex-app/styles.css`
- Verify: `/Users/macbook/Documents/codex-app/server.js`

- [x] Make desktop layout dense and stable at 1280px.
- [x] Make tablet/mobile layout usable with stacked rail, workspace, and inspector sections.
- [x] Run `node --check server.js && node --check script.js`.
- [x] Verify `/api/sync` still returns real data.
- [x] Run Playwright with system Chrome for desktop and mobile viewports.

# Anchor Selection Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split watermark candidate selection into "anchor selection" and "anchor refinement" so fixed Gemini anchor rules stay primary and local drift remains fallback-only.

**Architecture:** Keep current heuristics and tests, but refactor `selectInitialCandidate(...)` into two internal phases. The first phase chooses the base anchor candidate from standard/adaptive/preview-anchor search. The second phase refines only the chosen anchor with warp/gain logic. This keeps behavior easier to reason about and makes future "misalignment detection" work land on clear seams.

**Tech Stack:** Node `node:test`, existing core selector heuristics, no new runtime dependencies

---

### Task 1: Split Base Anchor Resolution From Anchor Refinement

**Files:**
- Modify: `src/core/candidateSelector.js`
- Test: `tests/core/candidateSelector.test.js`

- [ ] Extract internal helpers for:
  - building/promoting validated candidates
  - resolving the base anchor candidate before warp/gain refinement
  - refining the selected anchor candidate after the base anchor is chosen
- [ ] Keep current public contract of `selectInitialCandidate(...)` unchanged
- [ ] Add at least one regression-oriented test proving the refactor still preserves default-anchor preference when local drift evidence is weak

### Task 2: Verify Refactor On Existing Regression Surface

**Files:**
- Test: `tests/core/candidateSelector.test.js`
- Test: `tests/core/watermarkProcessor.test.js`

- [ ] Run targeted selector/processor tests
- [ ] Run full `pnpm test`
- [ ] Keep behavior-equivalent outputs for the existing debug download and portrait anchor regressions

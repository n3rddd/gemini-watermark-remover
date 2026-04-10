# Limitations

- This Skill is a thin wrapper over the `gwr` CLI. In this repo it prefers local `bin/gwr.mjs`; in standalone installs it depends on PATH (`gwr`, and on Windows typically `gwr.cmd`).
- Input sources are local files; remote URLs are out of scope.
- The Skill does not implement watermark-removal logic directly.

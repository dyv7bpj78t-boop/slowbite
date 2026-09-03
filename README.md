# SlowBite

A private, mobile-first meal pacer built as a static Progressive Web App. It has no backend, dependencies, analytics, login, or network requests after the first load.

## GitHub Pages

Publish the contents of `dist/` at the repository root, then enable GitHub Pages from the branch root. Every asset uses a relative URL, so the app works both at a user site (`name.github.io`) and a project site (`name.github.io/slowbite/`).

## Local preview

Serve `dist/` over HTTP. For example:

```sh
python3 -m http.server 8080 --directory dist
```

Then open `http://localhost:8080`.

## Behavior

- Defaults to a 20-minute meal and 30 seconds between bites.
- Stores active meal, settings, and the latest 100 meals in `localStorage`.
- Uses timestamp-based timing, so backgrounding or reloading does not distort elapsed time.
- Tries to keep the screen awake during a meal when the browser supports the Wake Lock API.
- Uses a Web Audio chime because iOS Safari does not expose web vibration/haptics.
- Registers a service worker so the site remains usable offline after the first visit.

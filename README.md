# Polysiege

Minimalist dark tower-defense React canvas component.

The main game component is `Polysiege.jsx`. The surrounding files turn it into a Vite React app that can be deployed with GitHub Pages.

- canvas rendering and game loop
- polygon enemy waves
- tower upgrades
- procedural Web Audio sound effects
- save/load hooks via `window.storage`

## Local Development

```bash
npm install
npm run dev
```

## GitHub Pages

This repository includes `.github/workflows/deploy-pages.yml`. On every push to `main`, GitHub Actions builds the Vite app and deploys `dist/` to GitHub Pages.

Before the first deploy, enable Pages in the repository settings:

1. Open **Settings > Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main`.

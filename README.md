# Copy for AI

Chrome extension (MV3): copy any page, selection or all tabs as clean Markdown for ChatGPT/Claude. Freemium via Lemon Squeezy license keys.

```
npm install
npm run build   # -> dist/ (load unpacked) + release/*.zip
npm run icons   # regenerate icons (needs Pillow)
CHROME_PATH=$(which google-chrome) node scripts/e2e.mjs   # end-to-end test
```

- `src/` extension source, `static/` html/css/icons, `site/` landing page, `docs/` store listing + launch guide.
- Pro config (checkout URL, store id) lives in `src/lib/config.js`.

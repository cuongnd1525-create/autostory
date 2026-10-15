const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const source = fs.readFileSync(path.resolve(__dirname, "../src/renderer.js"), "utf8");
window.cineviral = Object.fromEntries([...source.matchAll(/window\.cineviral\.(\w+)/g)].map((match) => [match[1], (...args) => args.some((arg) => typeof arg === "function") ? undefined : ipcRenderer.invoke("recap-ui-check", match[1], args)]));
window.cineviral.onProgress = (callback) => { window.__recapTestProgress = callback; };

# StarPilot USB Recovery

Browser recovery for AGNOS-compatible comma devices. It uses the pinned [comma USB programmer](https://github.com/commaai/flash) and the current AGNOS version and hardware manifests from the selected StarPilot branch. The @commaai/qdl library is MIT licensed.

```sh
bun install --frozen-lockfile
bun test
bun run build
python3 -m http.server 8719 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8719/ in desktop Chrome. All selected recovery operations run in one QUSB_BULK connection. Flash AGNOS alone preserves userdata. Delete old data erases only verified cache and userdata partitions and writes a clean ext4 filesystem. The page can include the chosen StarPilot branch and optional GitHub public keys and WPA2 Personal Wi-Fi settings. AGNOS applies the saved settings and starts the installed branch on first boot. The Wi-Fi password stays in the browser, which derives the key used by the comma. The flasher leaves persist alone.

Clean userdata bundles are published by the GitHub Actions workflow and served by the Cloudflare Pages worker. AGNOS manifests and install bundles use the same revision. The page stages and verifies the bundle and all selected AGNOS images before any writes. For local testing, use `scripts/build-offline-userdata.py` and `scripts/pack-offline-userdata.py` to create files under `dist/bundles/<revision-or-clean>/<sectors>/`. Stock userdata sizes backed by the supplied bundles are 89 and 90 GiB.

AGNOS recovery is available for comma 3, comma 3X, and current AGNOS models. Older devices running NEOS use a different flow.

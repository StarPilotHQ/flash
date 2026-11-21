# StarPilot USB Recovery

Browser recovery for AGNOS-compatible comma devices and StarPilot AGNOS 20.5.3. It uses the signed comma USB programmer from its pinned upstream URL and the AGNOS images pinned in `src/release.json`. It uses the `@commaai/qdl` library from comma.ai and contributors, which declares MIT licensing in the pinned package metadata.

```sh
bun install --frozen-lockfile
bun test
bun run build
python3 -m http.server 8719 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8719/ in desktop Chrome. The port guide is linked from the page.

The write path targets the inactive slot. It stages and verifies all seven images, requires the device to confirm each partition write, reads back and verifies the boot chain, and verifies the GPT update before asking the device to reboot. For a device that already has StarPilot, the installed app can start from the preserved data partition. Delete Old Data erases only the validated `cache` and `userdata` partitions, then AGNOS System Reset formats the empty storage. The flasher leaves `persist` alone. From AGNOS setup, Install Stable and Install Testing use the existing USB setup connection to hand the selected installer to AGNOS. Connect the comma itself to Wi-Fi before starting either one.

The flasher confirms the hardware identity before selecting its AGNOS manifest. AGNOS is available for comma 3, comma 3X, and current AGNOS models. Older devices running NEOS use a different recovery flow.

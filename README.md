# StarPilot USB Recovery

Browser recovery for AGNOS-compatible comma devices and StarPilot AGNOS. It uses the signed comma USB programmer from its pinned upstream URL and the current AGNOS version and device-specific manifests from a single commit on the selected StarPilot branch. It uses the `@commaai/qdl` library from comma.ai and contributors, which declares MIT licensing in the pinned package metadata.

```sh
bun install --frozen-lockfile
bun test
bun run build
python3 -m http.server 8719 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8719/ in desktop Chrome. The port guide is linked from the page.

The write path targets the inactive slot. It stages and verifies all seven images, requires the device to confirm each partition write, reads back and verifies the boot chain, and verifies the GPT update before asking the device to reboot. For a device that already has StarPilot, the installed app can start from the preserved data partition. Delete Old Data erases only the validated `cache` and `userdata` partitions, then AGNOS System Reset formats the empty storage. The flasher leaves `persist` alone. Select which operations to run and choose Stable or Testing for the AGNOS flash and StarPilot installer. The browser runs flash and erase in one recovery session. After reboot, connect the comma to Wi-Fi in AGNOS setup and press Continue recovery for any selected setup options. Pre-load SSH key takes a GitHub username, saves that account’s public SSH keys after any reset, and enables SSH before starting the StarPilot installer. This requires clean AGNOS setup and Wi-Fi.

The flasher confirms the hardware identity before selecting its AGNOS manifest. AGNOS is available for comma 3, comma 3X, and current AGNOS models. Older devices running NEOS use a different recovery flow.

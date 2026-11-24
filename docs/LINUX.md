# Linux x64 package

This archive contains the Linux x64 Bun server, the built web UI, icons, and bundled fonts. It does not include a desktop window shell; use a browser to open the local web app.

1. Extract `Rikkahub_<version>_linux_x64.tar.gz`.
2. Enter the extracted `rikkahub-pc/` directory.
3. Start the app:

   ```bash
   PORT=17455 RIKKAHUB_PC_DATA_DIR="$PWD/pc-data" ./rikkahub-pc --no-open
   ```

4. Open `http://127.0.0.1:17455` in a browser.

Keep `rikkahub-pc`, `web-ui/`, `fonts/`, and `icons/` together. The app stores its local settings, database, and other runtime data in `pc-data/`; back up this directory before upgrading. Stop the running process before replacing the program files.

The archive targets x86_64 Linux. `zip`, `unzip`, `curl`, `fontconfig`, and system TTS tools are optional runtime utilities; install them from your distribution when you use the corresponding features.

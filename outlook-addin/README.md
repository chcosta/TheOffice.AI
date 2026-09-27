# Pixel Writing Coach for Outlook

Pixel's Outlook compose add-in reads only the unsent message currently open in
the compose window. After typing pauses, it sends the draft to the local
TheOffice.AI server and displays:

- how the original wording may land;
- a professional and inclusive rewrite; and
- a short explanation of meaningful changes.

Pixel never sends or modifies the message. The rewrite can be copied and pasted
into Outlook explicitly.

## Install for local use

1. Install and trust the per-user localhost certificate:
   `npx --yes office-addin-dev-certs@2.0.10 install --days 3650`
2. Restart TheOffice.AI. Pixel exposes the compose pane only on
   `https://localhost:3849`.
3. In Outlook, open **Get Add-ins** or **Apps**.
4. Choose **My add-ins** > **Add a custom add-in** > **Add from file**.
5. Select `outlook-addin/manifest.xml` from a source checkout, or the packaged
   manifest at
   `%LOCALAPPDATA%\TheOffice.AI\server\outlook-addin\manifest.xml`.
6. Open a new message and select **Pixel** > **Writing coach** from the ribbon.
7. Pin the task pane if you want it available in each compose window.

The manifest targets a trusted, loopback-only HTTPS listener. The rewrite
endpoint also rejects non-loopback clients. The certificate and private key stay
in the current user's `.office-addin-dev-certs` directory and are not shipped in
the application or repository.

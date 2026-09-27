# Pixel Writing Coach for Outlook

Pixel's Outlook compose add-in reads only the unsent message currently open in
the compose window. After typing pauses, it sends the draft to the local
TheOffice.AI server and displays:

- how the original wording may land;
- a professional and inclusive rewrite; and
- a short explanation of meaningful changes.

Pixel never sends the message. The rewrite can be applied with one button or
copied explicitly. Apply preserves Outlook signatures and quoted history when
present, and refuses to overwrite a draft that changed after the suggestion was
generated.

## Install for local use

1. In Pixel, open **Setup** and choose **Install or update automatically**.
   Pixel uses Microsoft's supported M365 Agents Toolkit installer. If that
   installer isn't available, continue with the manual steps below.
2. Install and trust the per-user localhost certificate:
   `npx --yes office-addin-dev-certs@2.0.10 install --days 3650`
3. Restart TheOffice.AI. Pixel exposes the compose pane only on
   `https://localhost:3849`.
4. In Outlook, open **Get Add-ins** or **Apps**.
5. Choose **My add-ins** > **Add a custom add-in** > **Add from file**.
6. Select `outlook-addin/manifest.xml` from a source checkout, or the packaged
   manifest at
   `%LOCALAPPDATA%\TheOffice.AI\server\outlook-addin\manifest.xml`.
7. Open a new message and select **Pixel** > **Writing coach** from the ribbon.
8. Pin the task pane if you want it available in each compose window.

Version 2 adds one-click draft updates and therefore requests Outlook's
`ReadWriteMailbox` permission. It uses a distinct add-in ID so Outlook grants
that permission as a fresh installation instead of reusing a delayed, read-only
registration.

The manifest targets a trusted, loopback-only HTTPS listener. The rewrite
endpoint also rejects non-loopback clients. The certificate and private key stay
in the current user's `.office-addin-dev-certs` directory and are not shipped in
the application or repository.

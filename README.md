# Meadowcraft

A pastoral pixel-art multiplayer sandbox (Sheeple, goblin gangs, very angry geese). Static build: the world runs in the host's browser tab.

## Play online (GitHub Pages, peer-to-peer)

**Play:** https://joebu84.github.io/meadowcraft/

There is no game server. One player's browser tab *is* the world, and friends connect straight to that tab over WebRTC.

### Host a world
1. Open the link, type your name, and under **Host a world in this tab** pick **+ New world...** (optionally give it a name and a seed; the same seed always makes the same map) or choose a saved world.
2. Press **Host world**. You play in the same tab. The top-left badge shows **Hosting: room CODE, N players**.
3. Your world autosaves to this browser (IndexedDB) every 30 s and whenever you switch away from or close the tab. Reloading offers **Resume hosting room CODE**, and the room code stays the same for that world.

### Invite friends
- Press **Share link** in the badge. On phones this opens the share sheet; on desktop it copies `https://joebu84.github.io/meadowcraft/?room=CODE`.
- Friends open the link, type a name and press **Join room CODE**. Or they open the site and type the code under **Join a friend**.
- If the host's tab drops or reloads, friends see "Host disconnected, reconnecting..." and rejoin automatically, keeping their character and inventory.

### Saves
- **Export save** downloads the selected world as a `.json` file. **Import save** loads one, so you can move a world to another device or browser or keep a backup. **Delete** removes it from this browser.

### Caveats
- **The world is online only while the host's tab is open.** Closing the tab takes everyone offline; reopening it brings the same world and room code back.
- **Saves live only in the host's browser on that device.** Clearing site data, or using private browsing, loses them. Export to keep a backup, and import to move a world elsewhere.
- Keep the host tab in front where you can. The host asks the screen to stay awake and keeps ticking in a background tab on desktop, but **phones usually pause background tabs**, which freezes the world for everyone. A laptop or desktop makes the best host.
- Connections use the free PeerJS cloud for matchmaking and a free public TURN relay as a fallback for strict networks. Both are best-effort. Some school or corporate networks block WebRTC entirely.
- The host's tab is the authority: it is trusted, the same as a server.

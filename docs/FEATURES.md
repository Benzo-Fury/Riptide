# Features: what we considered, what we built, and why

Ideas drawn from qBittorrent, Transmission, Deluge, µTorrent, Tixati, BiglyBT/Vuze, WebTorrent and
Stremio, aria2/Motrix, and from tools outside torrenting (Raycast, Linear, Arc). Each was judged on
four things: will people say "wow", can the Undercurrent engine actually do it today, does it fit the
design (motion is data, function first), and what it risks.

## Built

| Feature | Inspired by | Why it made the cut |
|---|---|---|
| **Swarm view** (details drawer → Swarm) | Vuze/BiglyBT's swarm view, Tixati's graphs | The most "wow" per line of code, and true to the design spec: every packet you see is real traffic, at its real rate, from a peer at its real round trip. Pure UI, built on the peer stats we already fetch, so it can't break transfers. |
| **Command palette** (⌘K) | Raycast, Linear, VS Code | Makes the whole app reachable from the keyboard in two keystrokes: every action, filter and torrent, fuzzy-matched. Power users notice it at once, and it costs nothing when unused. |
| **Slow tide** (alternative limits + weekly schedule) | qBittorrent/Transmission "alternative speed limits" and scheduler, µTorrent's scheduler | A top request in every client. Undercurrent changes limits live, so switching is instant and never restarts anything. Painting hours on a week grid, with a switch in the status bar, menu and tray, beats every other client's version of this. |
| **VPN lock** (bind to an interface, fail closed) | qBittorrent's "network interface" option | The privacy feature torrent users care about most. Undercurrent pins *every* socket (peers, trackers, DHT, port mapping) to one address and opens nothing without it, which is stronger than most clients' binding. We added detection of the interface going down or changing, a notification, an `offline` state ("Waiting for the VPN") and a lock indicator. |
| **Web seeds** (Settings → Connection, details → Trackers) | qBittorrent, Transmission, aria2 (BEP 19 mirrors) | Linux images and archive.org list HTTP mirrors. Using them starts a download at full speed in a second instead of waiting for the swarm, and revives dead swarms. Up to 3 mirrors per torrent (libtorrent's default), slow mirrors swapped for faster ones, bad data bans a mirror. The Trackers tab shows each mirror's speed and errors. |
| **Keep the Mac awake** (Settings → Downloads) | `caffeinate -i`, Transmission's "prevent sleep" | macOS idle-sleeps a laptop after a few minutes (as little as one minute on battery), and network traffic doesn't count as activity, so downloads left running just stopped. The engine holds a `PreventUserIdleSystemSleep` assertion (Apple's recommendation, shown in `pmset -g assertions` as "Riptide is downloading") while data moves or files are checked, and for 5 minutes after. The display still sleeps; closing the lid still sleeps the Mac. On by default. |
| **Clipboard magnets** | Motrix, Folx, download managers | A small delight: copy a magnet in the browser, come back, and Riptide offers it, once. It can be switched off in Settings. |

## Not now

| Idea | Inspired by | Why not (yet) |
|---|---|---|
| Stream while downloading, play in the app | WebTorrent, Stremio, Popcorn Time | The biggest wow, but it needs sequential or deadline piece picking, and Undercurrent's picker has neither (its README lists "file priorities" as left out). Doing it properly means changing the engine library first. **The best next engine feature.** |
| File priorities (high, normal, low) | Every client | Same engine gap. Selecting files on and off already covers the main use. |
| Peer world map or globe | Tixati, BiglyBT | Needs a GeoIP database (several MB, with attribution terms) or an online lookup, and an online lookup would leak every peer's address to a third party, which is unacceptable for a torrent client. The swarm view gives the visual wow without either. |
| RSS auto-downloader with rules | qBittorrent, Flexget | Genuinely useful, but large: feeds, rules, a regex editor, history and a lot of interface. Worth its own project. |
| Web UI or phone remote | qBittorrent WebUI, Transmission | A whole authenticated server on the network: real security surface for a desktop app. |
| Watch folder | qBittorrent, Transmission | Useful but quiet. Opening .torrent files from Finder and dropping them on the window already cover most of it. Cheap to add later. |
| IP blocklists | Transmission, qBittorrent | Undercurrent supports `allow_peer`, but list formats, downloading and updating them are a feature of their own. A good follow-up for the privacy story. |
| Ambient sound of the current | Experimental | Charming for a minute, then it gets muted. It fails "function first". |
| uTP and hole punching | µTorrent, libtorrent | Helps only users who can't accept connections, and the main group (carrier-grade NAT) defeats hole punching anyway. uTP's congestion control makes transfers yield, not speed up. It would cost Undercurrent 1,500–2,500 lines, its zero-copy paths, and a new UDP attack surface. Port mapping and a VPN's forwarded port cover it. |
| Tags and categories with save paths | qBittorrent | Useful for big libraries, but it's management rather than wow. Later. |
| Lifetime stats ("you've shared 2 TB") | µTorrent, Tixati | Needs persistent counters across engine restarts. A nice, small follow-up. |

## Known limits of what was built

- **VPN lock:** Undercurrent's reconnect resumes every torrent. The daemon puts user-paused and queued
  torrents back on its next 500 ms tick, so one could briefly reconnect to peers when the VPN comes
  back. Traffic still only flows through the VPN.
- **VPN lock:** the interface going down and coming back mid-transfer is covered by unit tests of
  the lock and by an end-to-end test of an interface that is down. It hasn't been run against a
  real VPN that drops.
- **Slow tide schedule:** uses local time. A switch by hand lasts until the schedule's next change.
- **Keep awake:** checked against `pmset -g assertions` (held while downloading, gone when the engine
  exits, never taken with the setting off). The release 5 minutes after the last byte is a timer
  that hasn't been run end to end.

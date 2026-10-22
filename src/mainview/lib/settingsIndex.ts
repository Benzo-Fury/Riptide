/**
 * Every setting by name, for the command palette. The Settings view's fields carry the same
 * ids, so a match can be scrolled to and shown.
 */

export interface SettingEntry {
	id: string;
	/** The Settings view section it lives in, by heading. */
	section: string;
	label: string;
	/** Extra words that find it ("killswitch" finds the VPN lock). */
	keywords?: string;
}

export const SETTINGS_INDEX: SettingEntry[] = [
	{ id: "downloadDir", section: "Downloads", label: "Save new torrents to", keywords: "folder directory location path" },
	{ id: "maxActiveDownloads", section: "Downloads", label: "Downloads at once", keywords: "queue active concurrent simultaneous" },
	{ id: "preventSleep", section: "Downloads", label: "Keep the Mac awake while downloading", keywords: "sleep caffeinate insomnia power battery idle" },
	{ id: "notifyOnComplete", section: "Downloads", label: "Notify when a download finishes", keywords: "notification alert done complete" },
	{ id: "clipboardMagnets", section: "Downloads", label: "Offer magnet links I copy", keywords: "clipboard paste" },
	{ id: "defaultApp", section: "Default app", label: "Open torrent files and magnet links", keywords: "default handler association finder" },
	{ id: "downloadLimit", section: "Speed", label: "Download limit", keywords: "bandwidth rate throttle cap" },
	{ id: "uploadLimit", section: "Speed", label: "Upload limit", keywords: "bandwidth rate throttle cap" },
	{ id: "slowDownloadLimit", section: "Slow tide", label: "Slow download limit", keywords: "alternative turtle bandwidth throttle" },
	{ id: "slowUploadLimit", section: "Slow tide", label: "Slow upload limit", keywords: "alternative turtle bandwidth throttle" },
	{ id: "slowSchedule", section: "Slow tide", label: "Follow a schedule", keywords: "hours week time calendar" },
	{ id: "seedEnabled", section: "Seeding", label: "Keep sharing after a download finishes", keywords: "seed upload share" },
	{ id: "seedRatio", section: "Seeding", label: "Stop at ratio", keywords: "seed share" },
	{ id: "seedMinutes", section: "Seeding", label: "Stop after minutes", keywords: "seed time share" },
	{ id: "port", section: "Connection", label: "Listening port", keywords: "network incoming" },
	{ id: "acceptIncoming", section: "Connection", label: "Accept incoming connections", keywords: "listen inbound firewall" },
	{ id: "encryption", section: "Connection", label: "Encryption", keywords: "obfuscation privacy plaintext" },
	{ id: "portMapping", section: "Connection", label: "Map the port on your router", keywords: "upnp nat-pmp forwarding" },
	{ id: "dht", section: "Connection", label: "Find peers through the DHT", keywords: "trackerless distributed" },
	{ id: "pex", section: "Connection", label: "Swap peers with peers (PEX)", keywords: "exchange" },
	{ id: "maxPeers", section: "Connection", label: "Peers per torrent", keywords: "connections limit maximum" },
	{ id: "maxHalfOpen", section: "Connection", label: "Connection attempts at once", keywords: "half open half-open connecting dial maximum" },
	{ id: "webSeeds", section: "Connection", label: "Web seeds per torrent", keywords: "http mirrors url-list webseed getright" },
	{ id: "uploadSlots", section: "Connection", label: "Upload slots per torrent", keywords: "unchoke seed" },
	{ id: "maxBufferBytes", section: "Performance", label: "Memory per torrent", keywords: "buffer cache ram pieces" },
	{ id: "threads", section: "Performance", label: "Engine threads", keywords: "cpu cores workers" },
	{ id: "bindInterface", section: "VPN lock", label: "Lock connections to", keywords: "vpn killswitch kill switch interface bind privacy" },
];


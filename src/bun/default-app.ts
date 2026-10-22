/**
 * Whether Riptide is the Mac's default app for .torrent files and magnet links, and making it
 * so, through LaunchServices. The bundle claims both (see scripts/patch-info-plist.ts); this is
 * the user's choice between Riptide and any other torrent app that claims them too.
 */

import { dlopen, ptr, type Pointer } from "bun:ffi";
import type { DefaultApp } from "../shared/types";

/** The type macOS gives .torrent files. */
const TORRENT_UTI = "org.bittorrent.torrent";
const MAGNET_SCHEME = "magnet";

const kCFStringEncodingUTF8 = 0x08000100;
const kLSRolesAll = 0xffffffff;

// ---------- CoreFoundation and LaunchServices ---------- //

/** The few CoreFoundation and LaunchServices calls this needs, or null off macOS. */
function load() {
	if (process.platform !== "darwin") return null;
	try {
		const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
			CFStringCreateWithCString: { args: ["ptr", "cstring", "u32"], returns: "ptr" },
			CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "bool" },
			CFBundleGetMainBundle: { args: [], returns: "ptr" },
			CFBundleGetIdentifier: { args: ["ptr"], returns: "ptr" },
			CFRelease: { args: ["ptr"], returns: "void" },
		});
		const ls = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", {
			LSCopyDefaultRoleHandlerForContentType: { args: ["ptr", "u32"], returns: "ptr" },
			LSSetDefaultRoleHandlerForContentType: { args: ["ptr", "u32", "ptr"], returns: "i32" },
			LSCopyDefaultHandlerForURLScheme: { args: ["ptr"], returns: "ptr" },
			LSSetDefaultHandlerForURLScheme: { args: ["ptr", "ptr"], returns: "i32" },
		});
		return { ...cf.symbols, ...ls.symbols };
	} catch {
		return null;
	}
}

// ---------- Default app ---------- //

/** Reads and sets Riptide's place as the default torrent app. */
export class DefaultHandlers {
	private readonly api = load();
	/** This app's bundle id; null when not running from a bundle (tests, the web harness). */
	private readonly bundleId: string | null;

	constructor() {
		const bundle = this.api?.CFBundleGetMainBundle();
		const id = bundle ? (this.api!.CFBundleGetIdentifier(bundle) as Pointer | null) : null;
		this.bundleId = id ? this.read(id) : null;
	}

	/** Whether Riptide handles .torrent files and magnet links now. */
	status(): DefaultApp {
		if (!this.api || !this.bundleId) return { supported: false, torrents: false, magnets: false };
		const torrents = this.withString(TORRENT_UTI, (uti) => this.copied(this.api!.LSCopyDefaultRoleHandlerForContentType(uti, kLSRolesAll) as Pointer | null));
		const magnets = this.withString(MAGNET_SCHEME, (scheme) => this.copied(this.api!.LSCopyDefaultHandlerForURLScheme(scheme) as Pointer | null));
		return { supported: true, torrents: this.isMe(torrents), magnets: this.isMe(magnets) };
	}

	/** Makes Riptide the default for both. macOS may ask the user to confirm the magnet change. */
	makeDefault(): DefaultApp {
		if (!this.api || !this.bundleId) return this.status();
		this.withString(this.bundleId, (me) => {
			this.withString(TORRENT_UTI, (uti) => this.api!.LSSetDefaultRoleHandlerForContentType(uti, kLSRolesAll, me));
			this.withString(MAGNET_SCHEME, (scheme) => this.api!.LSSetDefaultHandlerForURLScheme(scheme, me));
		});
		return this.status();
	}

	// ---------- CFString helpers ---------- //

	/** Bundle ids compare without case, as LaunchServices does. */
	private isMe(id: string | null): boolean {
		return id !== null && id.toLowerCase() === this.bundleId!.toLowerCase();
	}

	/** Runs `fn` with a temporary CFString of `text`. */
	private withString<T>(text: string, fn: (s: Pointer) => T): T {
		const s = this.api!.CFStringCreateWithCString(null, Buffer.from(`${text}\0`), kCFStringEncodingUTF8) as Pointer;
		try {
			return fn(s);
		} finally {
			this.api!.CFRelease(s);
		}
	}

	/** A CFString the caller owns, as text, released. */
	private copied(s: Pointer | null): string | null {
		if (!s) return null;
		try {
			return this.read(s);
		} finally {
			this.api!.CFRelease(s);
		}
	}

	/** A CFString's text. */
	private read(s: Pointer): string | null {
		const buf = Buffer.alloc(1024);
		if (!this.api!.CFStringGetCString(s, ptr(buf), buf.length, kCFStringEncodingUTF8)) return null;
		return buf.toString("utf8", 0, buf.indexOf(0));
	}
}

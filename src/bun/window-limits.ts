/**
 * A minimum size for a window, set on the Mac's own NSWindow so the system stops the resize at
 * the limit, as it does for native apps. Electrobun has no option for it, but it hands out the
 * NSWindow pointer, and the rest is a few Objective-C messages.
 *
 * This code runs off the main thread, where AppKit must not be touched. So the size is wrapped in
 * an NSValue inside a dictionary (both safe to make on any thread), and the window is asked to
 * apply it on the main thread with key-value coding, which unwraps the NSValue into the NSSize
 * that `-setContentMinSize:` takes.
 */

import { CFunction, dlopen, type Pointer } from "bun:ffi";

// ---------- The Objective-C runtime ---------- //

/** objc_msgSend, typed for each kind of message sent here, or null off macOS. */
function load() {
	if (process.platform !== "darwin") return null;
	try {
		const objc = dlopen("/usr/lib/libobjc.A.dylib", {
			objc_getClass: { args: ["cstring"], returns: "ptr" },
			sel_registerName: { args: ["cstring"], returns: "ptr" },
			objc_msgSend: { args: [], returns: "void" },
		});
		// One function, called with a different signature per message. NSSize is two doubles,
		// which arm64 and x86-64 both pass in float registers, the same as two double arguments
		// Bun gives every symbol its address as `.ptr`, though its types don't say so
		const send = (objc.symbols.objc_msgSend as unknown as { ptr: Pointer }).ptr;
		const typed = (args: ("ptr" | "cstring" | "f64" | "bool")[]) => CFunction({ ptr: send, args: ["ptr", "ptr", ...args], returns: "ptr" });
		return {
			cls: (name: string) => objc.symbols.objc_getClass(Buffer.from(`${name}\0`)),
			sel: (name: string) => objc.symbols.sel_registerName(Buffer.from(`${name}\0`)),
			withString: typed(["cstring"]),
			withSize: typed(["f64", "f64"]),
			withTwo: typed(["ptr", "ptr"]),
			performOnMain: typed(["ptr", "ptr", "bool"]),
		};
	} catch {
		return null;
	}
}

let runtime: ReturnType<typeof load> | undefined;

// ---------- Minimum size ---------- //

/**
 * Sets the smallest content size `window` (an NSWindow pointer) may be resized to. Returns false
 * where that can't be done (off macOS, or without the window), so the caller can fall back.
 */
export function setMinimumSize(window: Pointer | null, width: number, height: number): boolean {
	const rt = (runtime ??= load());
	if (!rt || !window) return false;

	// The size as {contentMinSize: NSValue(NSSize)}; Electrobun has AppKit loaded by now
	const NSValue = rt.cls("NSValue");
	const NSString = rt.cls("NSString");
	const NSDictionary = rt.cls("NSDictionary");
	if (!NSValue || !NSString || !NSDictionary) return false;
	const size = rt.withSize(NSValue, rt.sel("valueWithSize:"), width, height);
	const key = rt.withString(NSString, rt.sel("stringWithUTF8String:"), Buffer.from("contentMinSize\0"));
	const values = rt.withTwo(NSDictionary, rt.sel("dictionaryWithObject:forKey:"), size, key);
	if (!values) return false;

	// Applied on the main thread; not waiting, so a busy main thread can't stall this one. The
	// dictionary is retained until it's delivered. The three objects are made once per window and
	// never released (there's no autorelease pool here), a few hundred bytes
	rt.performOnMain(window, rt.sel("performSelectorOnMainThread:withObject:waitUntilDone:"), rt.sel("setValuesForKeysWithDictionary:"), values, false);
	return true;
}

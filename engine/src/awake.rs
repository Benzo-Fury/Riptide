//! Keeping the Mac awake while torrents download. macOS sleeps an idle Mac after a few minutes
//! (one, on some laptops on battery), and network traffic doesn't count as activity, so a
//! download left running would stop until someone woke the Mac. While transfers move, we hold
//! a `PreventUserIdleSystemSleep` power assertion: the one `caffeinate -i` takes, and what Apple
//! recommends for long work the user started. The display still sleeps, closing a laptop's lid
//! still sleeps it, and macOS drops the assertion if this process ends.

/// A power assertion, held or not.
pub struct Awake {
    name: &'static str,
    assertion: Option<u32>,
}

impl Awake {
    /// `name` is what `pmset -g assertions` and Activity Monitor show.
    pub fn new(name: &'static str) -> Awake {
        Awake { name, assertion: None }
    }

    /// Holds or releases the assertion; nothing happens when that's already so.
    pub fn hold(&mut self, on: bool) {
        match (on, self.assertion) {
            (true, None) => self.assertion = sys::create(self.name),
            (false, Some(id)) => {
                sys::release(id);
                self.assertion = None;
            }
            _ => {}
        }
    }

    pub fn held(&self) -> bool {
        self.assertion.is_some()
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        self.hold(false);
    }
}

/// IOKit's power assertions, through CoreFoundation strings.
#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{CString, c_char, c_void};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    /// `kIOPMAssertionLevelOn`.
    const ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// Takes the assertion; `None` if macOS refused it.
    pub fn create(name: &str) -> Option<u32> {
        let cf = |s: &str| CString::new(s).map_or(std::ptr::null(), |c| unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) });
        let (kind, name) = (cf("PreventUserIdleSystemSleep"), cf(name));
        let mut id = 0;
        let ok = !kind.is_null() && !name.is_null() && unsafe { IOPMAssertionCreateWithName(kind, ON, name, &mut id) } == 0;
        for s in [kind, name].into_iter().filter(|s| !s.is_null()) {
            unsafe { CFRelease(s) };
        }
        ok.then_some(id)
    }

    pub fn release(id: u32) {
        unsafe { IOPMAssertionRelease(id) };
    }
}

/// Elsewhere there's nothing to hold.
#[cfg(not(target_os = "macos"))]
mod sys {
    pub fn create(_name: &str) -> Option<u32> {
        None
    }
    pub fn release(_id: u32) {}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Whether macOS lists an assertion by this name.
    fn listed(name: &str) -> bool {
        let out = std::process::Command::new("pmset").args(["-g", "assertions"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(name)
    }

    #[test]
    fn holds_and_releases_a_power_assertion() {
        let name = "Riptide test assertion";
        let mut a = Awake::new(name);
        a.hold(true);
        a.hold(true);
        assert!(a.held() && listed(name));
        a.hold(false);
        assert!(!a.held() && !listed(name));
        // Dropping releases it too
        a.hold(true);
        drop(a);
        assert!(!listed(name));
    }
}

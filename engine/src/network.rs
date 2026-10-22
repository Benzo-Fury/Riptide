//! Network interfaces, for the VPN lock: which interfaces the machine has, and the address one
//! of them has right now. Undercurrent pins every socket to the address the lock reports, and opens
//! nothing while there isn't one, so a VPN dropping out stops traffic instead of rerouting it.

use serde::Serialize;
use std::ffi::CStr;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, RwLock};

// ---------- Interfaces ---------- //

/// One interface and its usable addresses, as the Settings view lists them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    pub name: String,
    /// IPv4 first, then global IPv6; link-local addresses are left out.
    pub addresses: Vec<String>,
    /// Named like a tunnel (utun, tun, tap, wg, ppp, ipsec): probably a VPN.
    pub vpn: bool,
    pub loopback: bool,
}

/// Every interface that is up and has at least one usable address, VPNs first.
pub fn interfaces() -> Vec<Interface> {
    let mut by_name: Vec<Interface> = Vec::new();
    for (name, ip, loopback) in addresses() {
        // Group addresses under their interface
        let i = match by_name.iter().position(|i| i.name == name) {
            Some(i) => i,
            None => {
                by_name.push(Interface { vpn: looks_like_vpn(&name), name, addresses: Vec::new(), loopback });
                by_name.len() - 1
            }
        };
        by_name[i].addresses.push(ip.to_string());
    }

    // IPv4 before IPv6 within each; tunnels, then the rest, then loopback
    for i in &mut by_name {
        i.addresses.sort_by_key(|a| a.contains(':'));
    }
    by_name.sort_by_key(|i| (!i.vpn, i.loopback, i.name.clone()));
    by_name
}

/// The address to bind to on interface `name` right now: its first IPv4 address, else its
/// first global IPv6 one. `None` when the interface is down, gone or has no usable address.
pub fn address_of(name: &str) -> Option<IpAddr> {
    let mut found: Vec<IpAddr> = addresses().into_iter().filter(|(n, _, _)| n == name).map(|(_, ip, _)| ip).collect();
    found.sort_by_key(|ip| ip.is_ipv6());
    found.into_iter().next()
}

/// Whether an interface name is a tunnel's.
fn looks_like_vpn(name: &str) -> bool {
    ["utun", "tun", "tap", "wg", "ppp", "ipsec", "gpd", "zt"].iter().any(|p| name.starts_with(p))
}

/// (interface, address, is loopback) for every up interface's usable addresses.
fn addresses() -> Vec<(String, IpAddr, bool)> {
    let mut out = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return out;
    }

    // Walk the list the OS handed back, then free it
    let mut cur = head;
    while !cur.is_null() {
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        let up = ifa.ifa_flags & libc::IFF_UP as u32 != 0;
        if !up || ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        let Some(ip) = (unsafe { ip_of(ifa.ifa_addr) }) else { continue };
        if is_link_local(&ip) {
            continue;
        }
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) }.to_string_lossy().into_owned();
        out.push((name, ip, ifa.ifa_flags & libc::IFF_LOOPBACK as u32 != 0));
    }
    unsafe { libc::freeifaddrs(head) };
    out
}

/// The IP in a `sockaddr`, for the IPv4 and IPv6 families.
unsafe fn ip_of(addr: *const libc::sockaddr) -> Option<IpAddr> {
    match unsafe { (*addr).sa_family } as i32 {
        libc::AF_INET => {
            let a = unsafe { &*(addr as *const libc::sockaddr_in) };
            Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(a.sin_addr.s_addr))))
        }
        libc::AF_INET6 => {
            let a = unsafe { &*(addr as *const libc::sockaddr_in6) };
            Some(IpAddr::V6(Ipv6Addr::from(a.sin6_addr.s6_addr)))
        }
        _ => None,
    }
}

/// Link-local addresses (169.254/16, fe80::/10) can't carry traffic to the internet.
fn is_link_local(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

// ---------- Lock ---------- //

/// The VPN lock's view of its interface, shared with Undercurrent's bind function. The daemon
/// refreshes it every tick, so a socket opened between ticks binds to the latest address seen;
/// if that address has just vanished, the bind fails and nothing is sent.
#[derive(Clone)]
pub struct Lock {
    pub interface: String,
    address: Arc<RwLock<Option<IpAddr>>>,
}

impl Lock {
    /// A lock on `interface`, reading its address now.
    pub fn new(interface: &str) -> Lock {
        Lock { interface: interface.to_string(), address: Arc::new(RwLock::new(address_of(interface))) }
    }

    /// The address sockets bind to, or `None` while the interface is down.
    pub fn address(&self) -> Option<IpAddr> {
        *self.address.read().unwrap()
    }

    /// Reads the interface again. Returns the previous address when it changed.
    pub fn refresh(&self) -> Option<Option<IpAddr>> {
        let now = address_of(&self.interface);
        let mut slot = self.address.write().unwrap();
        if *slot == now {
            return None;
        }
        Some(std::mem::replace(&mut slot, now))
    }

    /// Undercurrent's bind function for this lock.
    pub fn bind_fn(&self) -> undercurrent::BindFn {
        let lock = self.clone();
        Arc::new(move || lock.address())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_has_an_address_and_unknown_interfaces_have_none() {
        let lo = if cfg!(target_os = "macos") { "lo0" } else { "lo" };
        assert_eq!(address_of(lo), Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert_eq!(address_of("riptide-no-such0"), None);
        assert!(interfaces().iter().any(|i| i.name == lo && i.loopback));
    }

    #[test]
    fn a_lock_on_a_missing_interface_stays_closed() {
        let lock = Lock::new("riptide-no-such0");
        assert_eq!(lock.address(), None);
        assert_eq!((lock.bind_fn())(), None);
        assert_eq!(lock.refresh(), None);
    }

    #[test]
    fn tunnels_are_recognised() {
        assert!(looks_like_vpn("utun4") && looks_like_vpn("wg0") && looks_like_vpn("tun0"));
        assert!(!looks_like_vpn("en0") && !looks_like_vpn("bridge100"));
    }
}
